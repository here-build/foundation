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
    [".scm", async (contents) => ({ kind: "load", forms: await parse(String(contents)) })],
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
  };
}

/** Wrap a legacy `path → source` resolver (CLI `--file` mode) as a Loader. */
export function loaderFromResolver(resolver: RequireResolver): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => resolver(path),
    resolvers: defaultResolvers(),
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
      } finally {
        loading.delete(path);
        loadingStack.pop();
      }
    },
  });
}
