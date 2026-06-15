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
 * Design (audit-hardened 2026-05-30; single-flight 2026-06-01):
 *   - `require` is STATEMENT-POSITION within a `.scm`: that file's forms are
 *     `execExpr`'d in order, to completion, so a required file's `define-macro`
 *     is installed before the caller's next form expands (R5RS `load`).
 *   - But requires are NOT globally sequential. `(map …)` evaluates its body in
 *     PARALLEL (`promise_all`), so the same path can be `(require)`d concurrently
 *     by N iterations. The loader is therefore SINGLE-FLIGHT: a path loads exactly
 *     once and every later require — sequential repeat OR concurrent sibling —
 *     shares that one promise. (The old flat in-flight Set read siblings #2…N as
 *     a cycle; that was the spurious `react.prompt → react.prompt` on any fan-out
 *     `(map (lambda (p) ((require "react.prompt") …)) …)`.)
 *   - Cycles THROW (R7RS forbids module cycles; no exports object to return
 *     "partial" in a spill model). Only `.scm` (`load`) can `require` during its
 *     OWN evaluation, so the cycle guard is scoped to it — value/eval modules
 *     (`.json`, `.prompt`, `.hbs`) are require-graph leaves and cannot cycle.
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
  jsToScheme,
  parseGenerator as parse,
} from "@here.build/arrival-scheme";
import { parse as parseToml } from "smol-toml";
import invariant from "tiny-invariant";
import { parse as parseYaml } from "yaml";

import { lookupExtensionResolver } from "./loader-extensions.js";
import type { Project } from "./project.js";

export type MaybePromise<T> = T | Promise<T>;

/** A parsed scheme form — exactly what `parse` yields and `execExpr` consumes.
 *  Derived from `parse` so we don't depend on the (unexported) `SchemeValue`. */
export type SchemeForm = Awaited<ReturnType<typeof parse>>[number];

/** What an extension resolver produces; the require rosetta executes it.
 *  - `load`  → `execExpr` each form into the run env (spill); require returns ⊥.
 *  - `eval`  → `execExpr` the forms, return the LAST value (e.g. an `.hbs` lambda).
 *  - `value` → return the (plain, membrane-safe) value; the caller binds it
 *    explicitly with `(define x (require …))`. No spill into the global env — a
 *    data file's binding is as greppable and provenance-clear as an import. A
 *    capability resolver that produces a native proc (e.g. `.prompt` → a sealed
 *    infer proc) returns it as a `value` too: `require`'s `jsToScheme` passes a
 *    function through untouched. */
export type ResolverResult =
  | { kind: "load"; forms: SchemeForm[] }
  | { kind: "eval"; forms: SchemeForm[] }
  | { kind: "value"; value: unknown };

export type ContentResolver = (contents: string | Uint8Array, ctx: { path: string }) => MaybePromise<ResolverResult>;

/** The EDITOR twin of a {@link ContentResolver}: given a `(require)`d file's raw
 *  source, synthesize the TS type the lens should give `(require "path")` —
 *  expressed in the lens vocabulary (`SStr`/`SNum`/`SBool`/`List<…>`/object
 *  literals), the same dialect rosetta `type:` strings already speak. Returns
 *  `null` when the handler has no static shape to offer (the lens falls back to
 *  `unknown`). PURE — it parses the source the same way `resolve` does, but
 *  never touches the runtime env. Co-located with `resolve` so a single
 *  registration teaches BOTH the runtime parse and the editor shape: register
 *  once → runtime + editor both updated, no drift. */
export type RequireTypeProvider = (source: string, ctx: { path: string }) => string | null;

/** An extension's handler: its runtime `resolve` and its optional editor `type`
 *  provider (the require analogue of a rosetta's `{ fn, type }`). */
export interface ExtensionHandler {
  resolve: ContentResolver;
  type?: RequireTypeProvider;
}

export interface Loader {
  /** Pure path math: specifier resolved against the importing module's dir →
   *  canonical root-relative key. Throws on escape above the root. */
  resolve(specifier: string, fromDir: string): MaybePromise<string>;
  /** The one IO call + the jail. Throws (located) if the key isn't in the root. */
  read(path: string): MaybePromise<string | Uint8Array>;
  /** extension → terminal handler (runtime resolve + editor type). Longest
   *  matching suffix wins. */
  resolvers: Map<string, ExtensionHandler>;
}

/** Single-function resolver (`path → source`). May be async — `Loader.read` awaits
 *  it — so a resolver can fetch a not-yet-loaded module on demand (e.g. over a fs). */
export type RequireResolver = (path: string) => MaybePromise<string>;

// ── path helpers (posix, no node:path dep — runs in browser + worker + node) ──

/** Normalize a posix path, dropping `.`/empty segments and applying `..`. Throws
 *  if `..` would escape above the root — the traversal jail. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    invariant(seg !== "\0" && !seg.includes("\0"), () => `require: invalid path (NUL byte): ${JSON.stringify(p)}`);
    if (seg === "..") {
      invariant(out.length > 0, () => `require: path escapes the project root: ${p}`);
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

/** Project a parsed value onto its JSON shape (Dates → ISO strings, drops
 *  undefined), matching the old `(json/parse "<canonical>")` contract. NOT a
 *  deep clone — `structuredClone` would preserve the non-JSON types we want gone. */
// eslint-disable-next-line unicorn/prefer-structured-clone -- JSON projection, not a clone
const normalizeToJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

// ── value → lens TS type ──────────────────────────────────────────────────────
//
// Synthesize the TS type string the lens gives `(require "data.json")`. Mirrors
// the runtime wrap (`jsToScheme`): a JS array becomes a scheme LIST (`List<T>`), a
// plain object an accessible record (`{ "k": T; … }`), scalars the branded base
// types. Pure + recursive with depth/breadth guards so a pathological blob
// degrades to `unknown` instead of emitting a megabyte of types. The output is
// the lens dialect (`SStr`/`SNum`/`SBool`/`List`), the same vocabulary rosetta
// `type:` strings are written in.

const TS_TYPE_MAX_DEPTH = 8;
const TS_TYPE_MAX_KEYS = 200;

/** Union the distinct element types of an array (order-preserving, deduped). */
function unionElementTypes(items: readonly unknown[], depth: number): string {
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(valueToTsType(item, depth + 1));
    if (seen.size > 24) return "unknown"; // too many distinct shapes — give up cleanly
  }
  if (seen.size === 0) return "unknown"; // empty array — element type unknown
  return [...seen].join(" | ");
}

/** Project a parsed (JSON-shaped) value onto its lens TS type string. */
export function valueToTsType(value: unknown, depth = 0): string {
  if (depth > TS_TYPE_MAX_DEPTH) return "unknown";
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "SStr";
    case "number":
      return "SNum";
    case "boolean":
      return "SBool";
    default:
      break;
  }
  if (Array.isArray(value)) {
    const elem = unionElementTypes(value, depth);
    return `List<${elem.includes(" | ") ? `(${elem})` : elem}>`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > TS_TYPE_MAX_KEYS) return "unknown";
    if (entries.length === 0) return "{}";
    const fields = entries.map(([k, v]) => `${JSON.stringify(k)}: ${valueToTsType(v, depth + 1)}`);
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

/** The default extension registry: `.scm` loads (spill), data files parse to a
 *  value (bound explicitly via `(define x (require …))`), `.txt` to a string,
 *  `.hbs` evaluates to a render lambda. */
export function defaultResolvers(): Map<string, ExtensionHandler> {
  // Data files share ONE parser per extension across both faces: `resolve`
  // parses + normalizes to the runtime value, `type` parses + synthesizes the
  // editor shape. Same `DATA_PARSERS[ext]` on both sides — the registration is
  // the single source, so the lens shape can never drift from the runtime value.
  const dataHandlers = Object.keys(DATA_PARSERS).map((ext): [string, ExtensionHandler] => [
    ext,
    {
      resolve: (contents) => ({
        kind: "value",
        value: normalizeToJson(DATA_PARSERS[ext]!(String(contents))),
      }),
      type: (source) => {
        try {
          return valueToTsType(normalizeToJson(DATA_PARSERS[ext]!(source)));
        } catch {
          return null; // unparseable mid-edit — no shape, lens falls back to unknown
        }
      },
    },
  ]);
  return new Map<string, ExtensionHandler>([
    // Pass the module path as `source` so a throw inside this file reads as
    // `path:line` in the scheme stack (L3). `.hbs` deliberately omits it — its
    // parsed forms are a synthetic `(lambda …)`, not the file's own content.
    [
      ".scm",
      { resolve: async (contents, { path }) => ({ kind: "load", forms: await parse(String(contents), undefined, path) }) },
    ],
    ...dataHandlers,
    [".txt", { resolve: (contents) => ({ kind: "value", value: String(contents) }), type: () => "SStr" }],
    // `.hbs` evaluates to a SCHEME lambda (not a raw JS fn — membrane-safe): the
    // call site does `((require "x.hbs") args)` or `(define f (require "x.hbs"))`.
    [
      ".hbs",
      {
        resolve: async (contents) => ({
          kind: "eval",
          forms: await parse(`(lambda args (template/handlebars ${JSON.stringify(String(contents))} args))`),
        }),
      },
    ],
    // `.prompt` (dotprompt) is NOT a loader builtin: sealing one needs the infer
    // resource, so it is registered by the `ext/prompt` CAPABILITY (its resolver
    // closes over infer/mcp). A bare loader has no infer to bind, so `.prompt`
    // intentionally has no fallback here — requiring one without rooting the
    // capability is a clean unbound-resolver error. See packs/ext-prompt.ts.
  ]);
}

/** Longest registered suffix that the basename ends with (extensions begin with
 *  `.`, so the match is dot-bounded). Terminal — one handler, no chaining. */
function pickHandler(path: string, resolvers: Map<string, ExtensionHandler>): ExtensionHandler | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  let best: { ext: string; handler: ExtensionHandler } | undefined;
  for (const [ext, handler] of resolvers) {
    if (base.length > ext.length && base.endsWith(ext) && (!best || ext.length > best.ext.length)) {
      best = { ext, handler };
    }
  }
  return best?.handler;
}

/** The editor seam: synthesize the TS type for `(require "path")` by routing the
 *  file's source through the SAME registry the runtime resolves with — so a
 *  custom extension registered with a `type` provider teaches the lens too. The
 *  studio calls this per data file and pushes the resulting `{ path → tsType }`
 *  to the lens. Returns `null` when no handler claims the path or its handler has
 *  no `type` provider (a `.scm` library, an opaque blob) — the lens then emits
 *  no `require` overload and the value stays `unknown`. */
export function resolveRequireType(loader: Loader, path: string, source: string): string | null {
  const handler = pickHandler(path, loader.resolvers);
  if (handler?.type === undefined) return null;
  try {
    return handler.type(source, { path });
  } catch {
    return null; // a throwing provider must never break the editor — degrade to unknown
  }
}

/** Default loader over a Project's VFS, confined to the flat key space.
 *
 *  `versionSet` pins replay fidelity: a `{path → versionIndex}` snapshot captured
 *  at invoke-start (see `Project.captureVersionSet`). When present, `read` serves
 *  EXACTLY that version of each file, so a multi-file run binds one coherent
 *  cut of the project for its whole duration — a concurrent `promoteDraft` on a
 *  `(require)`d library can't tear an in-flight run, and a hypothesis replays the
 *  same bytes the original saw. When ABSENT (sandbox / draft / one-shot
 *  `runSource`), `read` serves the LATEST version — the right default for a
 *  live-edit loop, which wants the head, not a frozen cut.
 *
 *  A path missing from a non-empty `versionSet` is one created AFTER the snapshot:
 *  it didn't exist for this run, so requiring it is a (legible) error — the run is
 *  pinned to the world as it was at admission, not to a moving head. */
export function makeProjectLoader(project: Project, versionSet?: ReadonlyMap<string, number>): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => {
      const file = project.files.get(path);
      invariant(file, `require: file not found in project: ${path}`);
      if (versionSet) {
        const idx = versionSet.get(path);
        invariant(
          idx !== undefined,
          `require: "${path}" was created after this run started (not in its pinned version-set) — runs bind the project as of invoke-start`,
        );
        const pinned = file.versions[idx];
        invariant(pinned, `require: "${path}" has no version ${idx} (pinned version-set is stale)`);
        return pinned.source;
      }
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
 *
 * Returns a `clearCache()` — the single-flight module cache (`inflight`) persists for
 * the life of this closure, which is fine within one run but stale across runs of a
 * SHARED env (a notebook kernel): a `(require "config.scm")` would resolve its
 * `define/overridable` holes ONCE and never see a later override. A shared-kernel host
 * calls `clearCache()` before each run so requires re-evaluate against the current
 * overrides (and current source). Within-run single-flight is untouched — the cache
 * fills during the run, clears before the next.
 */
export function defineRequireRosetta(opts: {
  env: Environment;
  loader: Loader;
  tap?: EvalTap;
  baseDir?: string;
}): () => void {
  const { env, loader, tap, baseDir = "" } = opts;
  // Single-flight module cache: each resolved path loads EXACTLY ONCE; every later
  // require — sequential repeat OR concurrent sibling — awaits that one promise.
  const inflight = new Map<string, Promise<{ value: unknown }>>();
  // Paths whose MODULE FORMS are mid-evaluation (`.scm` `load` kind only). A
  // re-entrant require of an evaluating path is a genuine R7RS cycle (a→b→a):
  // awaiting its in-flight promise would deadlock, so we throw the chain instead.
  // value/eval modules are leaves (can't require during load) → never here, so
  // their concurrent requires always take the safe dedup path. (A concurrent
  // require of the SAME `.scm` via `map` would also trip this, but spilling one
  // file's defines N times concurrently is ill-defined anyway — rejecting is fine.)
  const evaluating = new Set<string>();
  const loadingStack: string[] = []; // the `.scm` require chain, for the cycle / requireChain message
  // Current module's dir, for relative resolves. A shared stack assumes the
  // resolve dir is stable across concurrent requires — true for same-dir fan-out
  // (the common case: top-level `(map (require "x.prompt") …)`). Concurrent
  // requires of modules in DIFFERENT dirs doing relative nested requires could
  // mis-resolve; threading the dir per-chain needs evaluator context — deferred.
  const dirStack: string[] = [baseDir];

  env.defineRosetta("require", {
    type: "(specifier: SStr): unknown",
    fn: async (specifierArg: unknown) => {
      const path = await loader.resolve(String(specifierArg), dirStack.at(-1)!);

      const pending = inflight.get(path);
      if (pending) {
        // In-flight as our own ancestor → real cycle (awaiting would deadlock).
        // Otherwise a settled cache hit or a concurrent sibling — share the load.
        invariant(!evaluating.has(path), () => `require: cyclic dependency: ${[...loadingStack, path].join(" → ")}`);
        return (await pending).value;
      }

      const load = (async (): Promise<{ value: unknown }> => {
        const contents = await loader.read(path);
        // Registry overlay (proposal §7): a capability-registered resolver for this suffix
        // wins over the loader's built-in table. The registry stores the resolver verb's
        // NAME (process-global); we resolve it against THIS env (late-bind), so a
        // resource-armed resolver (e.g. `.prompt` → `prompt/compile`) uses THIS env's
        // resource. If the suffix is registered but the verb is NOT bound in this env (a
        // scope that didn't root the owning capability), we FALL THROUGH to the built-in
        // table — so during migration a bare loader still resolves it; once a suffix is
        // removed from `defaultResolvers`, that fallthrough naturally errors (no handler),
        // which IS the scoping guarantee (you must root the capability).
        const resolverName = lookupExtensionResolver(path);
        const registered = resolverName === undefined ? undefined : env.get(resolverName, { throwError: false });
        let result: ResolverResult;
        if (typeof registered === "function") {
          result = (await (registered as ContentResolver)(contents, { path })) as ResolverResult;
        } else {
          const handler = pickHandler(path, loader.resolvers);
          invariant(handler, `require: no resolver for ${path}`);
          result = await handler.resolve(contents, { path });
        }

        let value: unknown;
        if (result.kind === "value") {
          // Wrap JS→Scheme exactly as the old `json/parse` path did: arrays
          // become scheme LISTS (so `(length …)` works), plain objects become
          // SchemeJSObject (so `@`/`field` work). Pure value — `require` RETURNS
          // it for an explicit `(define x (require …))`; nothing is spilled.
          // A capability resolver that produced a native proc (e.g. `.prompt` →
          // a sealed infer proc) rides this same `value` path: `jsToScheme` passes
          // a function through untouched, so `require` returns the proc, bound via
          // `(define run-x (require "x.prompt"))`.
          value = jsToScheme(result.value);
        } else {
          // load / eval: evaluate the module's forms in order into the run env,
          // with the module's own dir on the stack for its relative requires.
          // Only `load` (`.scm`) can require during this eval, so only it enters
          // the cycle domain (`evaluating` / `loadingStack`).
          const isLoad = result.kind === "load";
          dirStack.push(dirOf(path));
          if (isLoad) {
            evaluating.add(path);
            loadingStack.push(path);
          }
          try {
            for (const form of result.forms) value = await execExpr(form, { env, tap });
          } finally {
            if (isLoad) {
              loadingStack.pop();
              evaluating.delete(path);
            }
            dirStack.pop();
          }
          if (isLoad) value = undefined; // `load` returns unspecified
        }
        return { value };
      })();

      inflight.set(path, load);
      try {
        return (await load).value;
      } catch (error) {
        // A failed load must not poison the cache — drop it so the path can be
        // retried (a transient read error isn't permanent; a real cycle / parse
        // error simply recurs). Then annotate the throw with the require chain
        // (which `require` led here: a → b → c). The DEEPEST require wins — outer
        // levels see it already set and leave it, so the chain reads
        // entry→failing-module. Survives evaluator propagation: an already-
        // SchemeError is re-thrown unchanged (evaluator.ts:615), and a plain
        // assignment to an Error object sticks. Best-effort (frozen → skip).
        inflight.delete(path);
        if (error !== null && typeof error === "object" && !("requireChain" in error)) {
          try {
            (error as { requireChain?: string[] }).requireChain = [...loadingStack, path];
          } catch {
            /* frozen/sealed error — annotation is best-effort */
          }
        }
        throw error;
      }
    },
  });

  // The host clears this between runs of a shared env so requires re-evaluate against
  // the current overrides + source (see the doc header). A no-op within a single run.
  return () => inflight.clear();
}
