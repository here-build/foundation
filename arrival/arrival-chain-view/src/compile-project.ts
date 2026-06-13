/**
 * Project assembly — the end-to-end step. Given a flat map of source files (the
 * `.scm` program + spilled `.scm` modules + `.prompt` files + data), an entry, and
 * a target `{language, prompts}`, emit a complete, self-contained, runnable
 * directory for one of the four matrix corners.
 *
 * The two languages need different glue, and that asymmetry is the whole story:
 *
 *   Python is already runnable. The emitter prints final module names directly —
 *   `from metric import metric`, `json.load(open(...))`, `open(...).read()` — so
 *   assembly is just "emit each file under its name + copy data + requirements.txt".
 *   No specifier rewrite, no export keyword (any top-level def is importable).
 *
 *   JS imports the ORIGINAL specifiers (`./metric.scm`, `./predict.prompt`,
 *   `./seed.txt`), so assembly rewrites them to the emitted filenames, turns the
 *   `.txt`/`.json` imports into real loads, and adds `export { … }` to spilled
 *   modules (a bare `const` isn't importable). It's a tsx-runnable TS project.
 *
 * Both wrap the entry's trailing expression in a print, so the program's result
 * (the GEPA-optimized candidate) actually reaches stdout.
 */
import { parseSexprs } from "@here.build/arrival-sweet";
import { cleanName } from "./names.js";
import { head, isAtom, isList, type Node } from "./nodes.js";
import { projectToJs } from "./project.js";
import { getPromptBackend, type PromptBackend } from "./prompt.js";
import { projectToPy, pyName } from "./python.js";

export interface CompileTarget {
  language: "js" | "py";
  /** Must belong to `language`: `ax`/`langchain-js` for js, `dspy`/`langchain-py` for py. */
  prompts: PromptBackend["id"];
}

export interface EmittedFile {
  path: string;
  content: string;
}

const BACKEND_LANG: Record<PromptBackend["id"], "js" | "py"> = {
  ax: "js",
  "langchain-js": "js",
  dspy: "py",
  "langchain-py": "py",
};

// Real registry versions (resolved via `npm view … dist-tags.latest`, 2026-06-06) — a
// generated runnable project pins its deps rather than floating "latest" to newest-on-
// install (the supply-chain posture in .claude/rules/npm-version-pinning.md). Bump
// deliberately; verify on the registry first.
const DEP_VERSIONS: Record<string, string> = {
  "@ax-llm/ax": "^22.0.2",
  "@langchain/core": "^1.1.48",
  "@langchain/openai": "^1.4.7",
  tsx: "^4.22.4",
  typescript: "^6.0.3",
};
const dep = (name: string): Record<string, string> => ({ [name]: DEP_VERSIONS[name]! });

const base = (p: string): string => p.split("/").pop() ?? p;
const extOf = (p: string): string => /\.([^.]+)$/.exec(p)?.[1] ?? "";
const stemOf = (p: string): string => base(p).replace(/\.[^.]+$/, "");

/** Cleaned (JS) top-level `define` names of a scheme source — the spill/export set. */
function topLevelDefineNames(src: string): string[] {
  const out: string[] = [];
  for (const form of parseSexprs(src) as Node[]) {
    if (isList(form) && head(form) === "define") {
      const sig = form.list[1];
      if (isList(sig) && isAtom(sig.list[0])) out.push(cleanName(sig.list[0].atom));
      else if (isAtom(sig)) out.push(cleanName(sig.atom));
    }
  }
  return out;
}

/** Rewrite a JS module's require-derived imports to runnable forms. */
function rewriteJsImports(code: string): string {
  let needsReadText = false;
  let body = code.replace(/^import (.+) from "(\.\/[^"]+)";$/gm, (full: string, what: string, spec: string): string => {
    switch (extOf(spec)) {
      case "scm":
        return `import ${what} from "${spec.replace(/\.scm$/, ".js")}";`;
      case "prompt":
        return `import ${what} from "${spec}.js";`; // ./predict.prompt → ./predict.prompt.js (tsx resolves .ts)
      case "json":
        return `import ${what} from "${spec}" with { type: "json" };`;
      case "txt":
        needsReadText = true;
        return `const ${what} = __readText(new URL("${spec}", import.meta.url), "utf8");`;
      default:
        return full;
    }
  });
  if (needsReadText) body = `import { readFileSync as __readText } from "node:fs";\n${body}`;
  return body;
}

/** Wrap the entry module's trailing expression so its value is printed. */
function printEntryResult(code: string, lang: "js" | "py"): string {
  const lines = code.split("\n");
  const isComment = (l: string): boolean => (lang === "py" ? l.trimStart().startsWith("#") : l.trimStart().startsWith("//"));
  let i = lines.length - 1;
  while (i >= 0 && (lines[i]!.trim() === "" || isComment(lines[i]!))) i--;
  if (i < 0) return code;
  const expr = lines[i]!.trim().replace(/;$/, "");
  lines[i] =
    lang === "py"
      ? `import json as __json\nprint(__json.dumps(${expr}, indent=2, ensure_ascii=False, default=str))`
      : `const __result = ${expr};\nconsole.log(typeof __result === "string" ? __result : JSON.stringify(__result, null, 2));`;
  return lines.join("\n");
}

function manifest(target: CompileTarget, entryStem: string): EmittedFile {
  if (target.language === "py") {
    const reqs = target.prompts === "dspy" ? "dspy\n" : "langchain-core\nlangchain-openai\n";
    return { path: "requirements.txt", content: reqs };
  }
  const deps =
    target.prompts === "ax" ? dep("@ax-llm/ax") : { ...dep("@langchain/core"), ...dep("@langchain/openai") };
  const pkg = {
    name: `host-${entryStem}`,
    private: true,
    type: "module",
    scripts: { start: `tsx ${entryStem}.ts` },
    dependencies: deps,
    devDependencies: { ...dep("tsx"), ...dep("typescript") },
  };
  return { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" };
}

/**
 * Assemble a runnable project for one matrix corner. `files` is a flat
 * filename→source map (the `requireSource` injection point); `entry` is the program
 * `.scm`. Returns the files to write — pure, no fs.
 */
export async function compileProject(
  files: Record<string, string>,
  entry: string,
  target: CompileTarget,
): Promise<EmittedFile[]> {
  if (BACKEND_LANG[target.prompts] !== target.language) {
    throw new Error(`prompt backend "${target.prompts}" is not a ${target.language} backend`);
  }
  const backend = getPromptBackend(target.prompts);
  const requireSource = (p: string): string | undefined => files[base(p)];
  const out: EmittedFile[] = [];

  const scmFiles = Object.keys(files).filter((f) => extOf(f) === "scm");
  const promptFiles = Object.keys(files).filter((f) => extOf(f) === "prompt");
  const dataFiles = Object.keys(files).filter((f) => !["scm", "prompt"].includes(extOf(f)));

  for (const f of scmFiles) {
    const isEntry = f === entry;
    // The entry script is named `main` — nothing imports it, and a neutral name
    // dodges collisions where the program's own filename shadows an installed
    // package (e.g. `gepa.py` vs dspy's `gepa` dependency on Python's sys.path).
    if (target.language === "py") {
      let code = projectToPy(files[f]!, { requireSource, target: "run" });
      if (isEntry) code = printEntryResult(code, "py");
      out.push({ path: `${isEntry ? "main" : pyName(stemOf(f))}.py`, content: code });
    } else {
      let code = rewriteJsImports(await projectToJs(files[f]!, { requireSource, target: "run" }));
      if (isEntry) code = printEntryResult(code, "js");
      else {
        const names = topLevelDefineNames(files[f]!);
        if (names.length) code += `\nexport { ${names.join(", ")} };\n`;
      }
      out.push({ path: `${isEntry ? "main" : cleanName(stemOf(f))}.ts`, content: code });
    }
  }

  for (const f of promptFiles) {
    const m = backend.compile(files[f]!, stemOf(f));
    out.push({ path: m.filename, content: m.code });
  }

  const client = backend.client();
  out.push({ path: client.filename, content: client.code });

  for (const f of dataFiles) out.push({ path: base(f), content: files[f]! });

  out.push(manifest(target, "main"));
  return out;
}
