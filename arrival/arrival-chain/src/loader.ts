/**
 * Runtime module loader for `(require …)`.
 *
 * Replaces the old textual-splice `resolveRequires`. `require` is now an ordinary
 * runtime rosetta: it resolves a specifier against a `Loader` (a capability —
 * project VFS by default, or a real/virtual FS, or disabled), reads the file,
 * turns its bytes into a value/forms via an extension resolver, and either spills
 * the module's defines into the run env (`.scm` — `load` semantics) or returns a
 * value (data / template). See docs/working-proposals/todo/require-import-loader.md.
 *
 * Design (audit-hardened 2026-05-30):
 *   - `require` is STATEMENT-POSITION + EAGER-SEQUENTIAL: a `.scm` file's forms
 *     are `execExpr`'d in order, to completion, before `require` returns. This is
 *     why the simple loaded/loading guard is race-free (no concurrent requires),
 *     the dir stack is push/pop-sequential, and a required file's `define-macro`
 *     is installed before the caller's next form expands (R5RS `load`).
 *   - Cycles THROW (R7RS forbids module cycles; no exports object to return
 *     "partial" in a spill model).
 *   - The reader is the security boundary: `resolve` normalizes posix paths
 *     relative to the importing module's dir and REJECTS escapes above the root;
 *     `read` only serves keys inside the root. (Trivial for the flat project VFS
 *     today; load-bearing once folder/gh-repo substrates bring real directories.)
 *   - Resolvers are TERMINAL (esbuild model — one per longest-matching suffix, no
 *     chaining).
 */
import {
  type Environment,
  type EvalTap,
  execGeneratorExpr as execExpr,
  jsToLips,
  parseGenerator as parse,
} from "@here.build/arrival-scheme";
import { parse as parseToml } from "smol-toml";
import invariant from "tiny-invariant";
import { parse as parseYaml } from "yaml";

import type { Project } from "./project.js";

export type MaybePromise<T> = T | Promise<T>;

/** A parsed scheme form — exactly what `parse` yields and `execExpr` consumes.
 *  Derived from `parse` so we don't depend on the (unexported) `SchemeValue`. */
export type SchemeForm = Awaited<ReturnType<typeof parse>>[number];

/** What an extension resolver produces; the require rosetta executes it.
 *  - `load`  → `execExpr` each form into the run env (spill); require returns ⊥.
 *  - `eval`  → `execExpr` the forms, return the LAST value (e.g. an `.hbs` lambda).
 *  - `value` → bind `bindAs` (if set) and return the (plain, membrane-safe) value. */
export type ResolverResult =
  | { kind: "load"; forms: SchemeForm[] }
  | { kind: "eval"; forms: SchemeForm[] }
  | { kind: "value"; value: unknown; bindAs?: string };

export type ContentResolver = (contents: string | Uint8Array, ctx: { path: string }) => MaybePromise<ResolverResult>;

export interface Loader {
  /** Pure path math: specifier resolved against the importing module's dir →
   *  canonical root-relative key. Throws on escape above the root. */
  resolve(specifier: string, fromDir: string): MaybePromise<string>;
  /** The one IO call + the jail. Throws (located) if the key isn't in the root. */
  read(path: string): MaybePromise<string | Uint8Array>;
  /** extension → terminal resolver. Longest matching suffix wins. */
  resolvers: Map<string, ContentResolver>;
  /** `import` name → host-provided value (a membrane namespace, a proc, any
   *  value). Evaluate-once — holds already-built values. This is the curated
   *  capability set a run is granted; `require` is FS, `import` is the registry. */
  imports: Map<string, unknown>;
}

/** Legacy single-function resolver (CLI `--file` mode): `path → source`. */
export type RequireResolver = (path: string) => string;

// ── path helpers (posix, no node:path dep — runs in browser + worker + node) ──

/** Normalize a posix path, dropping `.`/empty segments and applying `..`. Throws
 *  if `..` would escape above the root — the traversal jail. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "\0" || seg.includes("\0")) throw new Error(`require: invalid path (NUL byte): ${JSON.stringify(p)}`);
    if (seg === "..") {
      if (out.length === 0) throw new Error(`require: path escapes the project root: ${p}`);
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/** Resolve `specifier` against `fromDir`. A leading `/` is root-relative. */
function joinPath(fromDir: string, specifier: string): string {
  if (specifier.startsWith("/")) return normalizePath(specifier);
  return normalizePath(fromDir ? `${fromDir}/${specifier}` : specifier);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// ── data parsers (moved from require.ts) ──────────────────────────────────────

const DATA_PARSERS: Record<string, (text: string) => unknown> = {
  ".json": (text) => JSON.parse(text),
  ".yaml": (text) => parseYaml(text),
  ".yml": (text) => parseYaml(text),
  ".toml": (text) => parseToml(text),
  ".ndjson": (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line)),
};

/** `_lib.scm` → `_lib`, `data.json` → `data`. The spilled binding name. */
function pathToIdent(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/** Project a parsed value onto its JSON shape (Dates → ISO strings, drops
 *  undefined), matching the old `(json/parse "<canonical>")` contract. NOT a
 *  deep clone — `structuredClone` would preserve the non-JSON types we want gone. */
// eslint-disable-next-line unicorn/prefer-structured-clone -- JSON projection, not a clone
const normalizeToJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** A `.chat.hbs` file is split into role-tagged sections by `{{role "x"}}`
 *  markers — the dotprompt convention. The split happens HERE, at load time,
 *  over the trusted author source, BEFORE any call-site value is interpolated.
 *  That's the security property: a rendered hole value containing the literal
 *  text `{{role "user"}}` lands inside one section as plain text and can never
 *  forge a new message boundary (the boundaries are fixed before substitution).
 *  Contrast dotprompt's own parser, which renders first then splits a flat
 *  string on in-band sentinels — injectable by untrusted content. */
const CHAT_ROLES = new Set(["system", "user", "assistant"]);
const ROLE_MARKER = /\{\{\s*role\s+["']([a-zA-Z]+)["']\s*\}\}/g;

export function splitChatSections(src: string): { role: string; body: string }[] {
  const sections: { role: string; body: string }[] = [];
  let bodyStart = 0;
  let role: string | null = null;
  ROLE_MARKER.lastIndex = 0;
  for (let m = ROLE_MARKER.exec(src); m; m = ROLE_MARKER.exec(src)) {
    if (role === null) {
      if (src.slice(0, m.index).trim() !== "") {
        throw new Error(
          `.chat.hbs: text before the first {{role}} marker — a chat template must open with {{role "system|user|assistant"}}`,
        );
      }
    } else {
      sections.push({ role, body: src.slice(bodyStart, m.index).trim() });
    }
    const next = m[1]!.toLowerCase();
    if (!CHAT_ROLES.has(next)) {
      throw new Error(`.chat.hbs: unknown role "${m[1]}" — use system, user, or assistant`);
    }
    role = next;
    bodyStart = ROLE_MARKER.lastIndex;
  }
  if (role === null) {
    throw new Error(`.chat.hbs: no {{role "..."}} markers — a chat template needs at least one`);
  }
  sections.push({ role, body: src.slice(bodyStart).trim() });
  return sections;
}

// ── .prompt (dotprompt) support ──────────────────────────────────────────────
//
// A `.prompt` file is a whole inference unit: YAML frontmatter (`model:` tier +
// optional Picoschema `output:`) over a `{{role}}`-marked body. `(require)`ing
// one yields a lambda `(key . kv)` that RUNS infer/chat with the frontmatter
// tier, the compiled output schema, and the rendered messages — so the verbose
// `s/object` schema blocks, the tier, and the (list (system…)(user…)) ceremony
// all collapse into the file. The cache-key stays a call argument (it's the
// provenance/dedup identity — often a computed loop key like "V0/p1/3" that
// inputs alone don't determine), passed first.

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** Split `"type, the description"` (Picoschema's scalar form) on the first comma. */
function splitTypeDesc(s: string): { type: string; desc: string } {
  const i = s.indexOf(",");
  return i === -1 ? { type: s.trim(), desc: "" } : { type: s.slice(0, i).trim(), desc: s.slice(i + 1).trim() };
}

/** Picoschema (the dotprompt schema shorthand) → `s/…` scheme source. Supports
 *  scalars (`field: type, desc`), `field(enum): [..]`, `field(array): elem|map`,
 *  `field(object): map`, parenthetical `type, desc`, and nesting. Optional `?`
 *  is rejected — the `s/` schema has no optional marker (add one before lifting). */
function compilePicoschema(node: unknown): string {
  if (!isPlainObject(node)) throw new Error(".prompt: output schema must be a map of fields");
  const fields = Object.entries(node).map(([k, v]) => compilePicoField(k, v));
  return `(s/object ${fields.join(" ")})`;
}

function scalarFieldSrc(name: string, type: string, desc: string): string {
  if (!SCALAR_TYPES.has(type)) throw new Error(`.prompt: unknown scalar type "${type}" for field "${name}"`);
  const d = desc ? ` ${JSON.stringify(desc)}` : "";
  return `(s/field/${type} ${JSON.stringify(name)}${d})`;
}

function compileElement(val: unknown): string {
  if (typeof val === "string") {
    const { type } = splitTypeDesc(val);
    if (!SCALAR_TYPES.has(type)) throw new Error(`.prompt: unknown array element type "${type}"`);
    return JSON.stringify(type);
  }
  if (isPlainObject(val)) return compilePicoschema(val);
  throw new Error(".prompt: array element must be a scalar type or an object map");
}

function compilePicoField(rawKey: string, val: unknown): string {
  const m = rawKey.match(/^([A-Za-z_][\w-]*)(\??)(?:\(([^)]*)\))?$/);
  if (!m) throw new Error(`.prompt: malformed schema key "${rawKey}"`);
  const name = m[1]!;
  if (m[2]) throw new Error(`.prompt: optional field "${name}" — optional schema fields aren't supported yet`);
  const q = JSON.stringify(name);
  if (m[3] === undefined) {
    const { type, desc } = splitTypeDesc(String(val)); // scalar; type+desc in the value
    return scalarFieldSrc(name, type, desc);
  }
  const { type, desc } = splitTypeDesc(m[3]); // composite; type+desc in the parens
  const d = desc ? ` ${JSON.stringify(desc)}` : "";
  if (type === "enum") {
    const vals = (val as unknown[]).map((v) => JSON.stringify(String(v))).join(" ");
    return `(s/field/enum ${q}${d} (s/enum ${vals}))`;
  }
  if (type === "array") return `(s/field/array ${q}${d} (s/array ${compileElement(val)}))`;
  if (type === "object") return `(s/field/object ${q}${d} ${compilePicoschema(val)})`;
  return scalarFieldSrc(name, type, desc); // explicit scalar type in parens
}

/** Strip a leading `---\n…\n---` YAML frontmatter block (optional) from a `.prompt`. */
function parsePromptFile(src: string): { fm: Record<string, unknown>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: src };
  const fm = parseYaml(m[1]!) ?? {};
  if (!isPlainObject(fm)) throw new Error(".prompt: frontmatter must be a YAML map");
  return { fm, body: src.slice(m[0].length) };
}

/** The default extension registry: `.scm` loads (spill), data files parse to a
 *  bound value, `.txt` binds a string, `.hbs` evaluates to a render lambda. */
export function defaultResolvers(): Map<string, ContentResolver> {
  const dataResolvers = Object.keys(DATA_PARSERS).map((ext): [string, ContentResolver] => [
    ext,
    (contents, { path }) => ({
      kind: "value",
      value: normalizeToJson(DATA_PARSERS[ext]!(String(contents))),
      bindAs: pathToIdent(path),
    }),
  ]);
  return new Map<string, ContentResolver>([
    // Pass the module path as `source` so a throw inside this file reads as
    // `path:line` in the scheme stack (L3). `.hbs` deliberately omits it — its
    // parsed forms are a synthetic `(lambda …)`, not the file's own content.
    [".scm", async (contents, { path }) => ({ kind: "load", forms: await parse(String(contents), undefined, path) })],
    ...dataResolvers,
    [".txt", (contents, { path }) => ({ kind: "value", value: String(contents), bindAs: pathToIdent(path) })],
    // `.hbs` evaluates to a SCHEME lambda (not a raw JS fn — membrane-safe): the
    // call site does `((require "x.hbs") args)` or `(define f (require "x.hbs"))`.
    [
      ".hbs",
      async (contents) => ({
        kind: "eval",
        forms: await parse(`(lambda args (template/handlebars ${JSON.stringify(String(contents))} args))`),
      }),
    ],
    // `.prompt` (dotprompt) evaluates to a lambda `(key . kv)` that RUNS
    // infer/chat: tier + output schema come from the YAML frontmatter, the
    // message list from the {{role}}-split body, the cache-key from the call.
    // Sections split HERE (trusted, pre-interpolation), so a rendered hole value
    // containing `{{role "user"}}` lands as inert text in one section and can
    // never forge a turn. Each body renders via the ordinary template/handlebars
    // path against ONE shared dict (`apply dict kv`); extra keys a section
    // doesn't use are tolerated (validateShape checks only a template's own
    // fields). Returns the unwrapped result (infer/chat yields `[value]`).
    // Longest-suffix resolution routes `*.prompt` here.
    [
      ".prompt",
      async (contents) => {
        const { fm, body } = parsePromptFile(String(contents));
        const tier = fm.model ?? fm.tier;
        if (typeof tier !== "string") {
          throw new Error('.prompt: frontmatter needs a `model:` (our tier, e.g. "fast" or "high")');
        }
        const schemaSrc = fm.output === undefined ? "#f" : compilePicoschema(fm.output);
        const msgs = splitChatSections(body)
          .map((s) => `(list ${JSON.stringify(s.role)} (template/handlebars ${JSON.stringify(s.body)} d))`)
          .join(" ");
        return {
          kind: "eval",
          forms: await parse(
            `(lambda (key . kv) (let ((d (apply dict kv))) (car (infer/chat ${JSON.stringify(tier)} (list ${msgs}) ${schemaSrc} key))))`,
          ),
        };
      },
    ],
  ]);
}

/** Longest registered suffix that the basename ends with (extensions begin with
 *  `.`, so the match is dot-bounded). Terminal — one resolver, no chaining. */
function pickResolver(path: string, resolvers: Map<string, ContentResolver>): ContentResolver | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  let best: { ext: string; fn: ContentResolver } | undefined;
  for (const [ext, fn] of resolvers) {
    if (base.length > ext.length && base.endsWith(ext) && (!best || ext.length > best.ext.length)) {
      best = { ext, fn };
    }
  }
  return best?.fn;
}

/** Default loader over a Project's VFS. `read` serves `project.files` (latest
 *  version — TODO: pin to the run's version snapshot for full replay fidelity),
 *  confined to the flat key space. */
export function makeProjectLoader(project: Project): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => {
      const file = project.files.get(path);
      invariant(file, `require: file not found in project: ${path}`);
      const latest = file.versions.at(-1);
      invariant(latest, `require: file has no versions: ${path}`);
      return latest.source;
    },
    resolvers: defaultResolvers(),
    imports: new Map(),
  };
}

/** Wrap a legacy `path → source` resolver (CLI `--file` mode) as a Loader. */
export function loaderFromResolver(resolver: RequireResolver): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => resolver(path),
    resolvers: defaultResolvers(),
    imports: new Map(),
  };
}

/**
 * Define the runtime `require` rosetta on `env`. Closes over the loader, the run
 * env, the trace tap, and the per-run load state. Statement-position +
 * eager-sequential (see module header). Cycles throw.
 */
export function defineRequireRosetta(opts: {
  env: Environment;
  loader: Loader;
  tap?: EvalTap;
  baseDir?: string;
}): void {
  const { env, loader, tap, baseDir = "" } = opts;
  const loaded = new Map<string, { value: unknown }>(); // resolved-once cache (path → value)
  const loading = new Set<string>();
  const loadingStack: string[] = []; // ordered, for the cycle-chain message
  const dirStack: string[] = [baseDir]; // current module's dir, for relative resolves

  env.defineRosetta("require", {
    fn: async (specifierArg: unknown) => {
      const path = await loader.resolve(String(specifierArg), dirStack.at(-1)!);
      const cached = loaded.get(path);
      if (cached) return cached.value;
      if (loading.has(path)) {
        throw new Error(`require: cyclic dependency: ${[...loadingStack, path].join(" → ")}`);
      }
      loading.add(path);
      loadingStack.push(path);
      try {
        const contents = await loader.read(path);
        const resolver = pickResolver(path, loader.resolvers);
        invariant(resolver, `require: no resolver for ${path}`);
        const result = await resolver(contents, { path });

        let value: unknown;
        if (result.kind === "value") {
          // Wrap JS→Scheme exactly as the old `json/parse` path did: arrays
          // become scheme LISTS (so `(length …)` works), plain objects become
          // SchemeJSObject (so `@`/`field` work). env.set passes Scheme values
          // through unchanged — its raw fromJS would keep arrays as vectors.
          const wrapped = jsToLips(result.value);
          if (result.bindAs !== undefined) env.set(result.bindAs, wrapped);
          value = wrapped;
        } else {
          // load / eval: evaluate the module's forms in order into the run env,
          // with the module's own dir on the stack for its relative requires.
          dirStack.push(dirOf(path));
          try {
            for (const form of result.forms) value = await execExpr(form, { env, tap });
          } finally {
            dirStack.pop();
          }
          if (result.kind === "load") value = undefined; // `load` returns unspecified
        }
        loaded.set(path, { value });
        return value;
      } catch (error) {
        // Annotate a throw from inside a required module with the require chain
        // (which `require` led here: a → b → c). The DEEPEST require wins —
        // outer levels see it already set and leave it, so the chain reads
        // entry→failing-module. Survives evaluator propagation: an
        // already-SchemeError is re-thrown unchanged (evaluator.ts:615), and a
        // plain assignment to an Error object sticks. Best-effort (frozen → skip).
        if (error !== null && typeof error === "object" && !("requireChain" in error)) {
          try {
            (error as { requireChain?: string[] }).requireChain = [...loadingStack];
          } catch {
            /* frozen/sealed error — annotation is best-effort */
          }
        }
        throw error;
      } finally {
        loading.delete(path);
        loadingStack.pop();
      }
    },
  });
}

/**
 * Builder for an `import`-able module value: wrap a record of named exports into
 * a membrane namespace. `@`/`field` access on it routes through the sandbox
 * boundary (so a granted capability can't be unwrapped to reach host internals —
 * see the accessor-isolation hardening). Pre-wrapping once gives evaluate-once
 * identity: `(eq? (import "x") (import "x"))` holds.
 *
 *   loader.imports.set("greet-lib", defineImport({ greet: (n) => `hi ${n}` }))
 *   ;; scheme:  (define lib (import "greet-lib"))  ((@ lib "greet") "world")
 *
 * For a bare value import (a proc, a constant) register it directly — no wrap
 * needed; the `import` rosetta's return path membrane-wraps on the way out.
 */
export function defineImport(exports: Record<string, unknown>): unknown {
  return jsToLips(exports);
}

/**
 * Define the `import` rosetta on `env`: `(import "name")` → host registry lookup
 * (`loader.imports`) → the stored value. Unregistered → error listing what IS
 * registered. Unlike `require`, `import` is FS-free and always available — it's
 * the curated capability set, not file access.
 */
export function defineImportRosetta(opts: { env: Environment; loader: Loader }): void {
  const { env, loader } = opts;
  env.defineRosetta("import", {
    fn: (nameArg: unknown) => {
      const name = String(nameArg);
      if (!loader.imports.has(name)) {
        const known = [...loader.imports.keys()];
        throw new Error(
          `import: unknown module "${name}" (registered: ${known.length > 0 ? known.join(", ") : "none"})`,
        );
      }
      return loader.imports.get(name);
    },
  });
}
