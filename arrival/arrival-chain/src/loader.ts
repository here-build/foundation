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

/** A `.prompt` parsed into a SEALED inference unit (the dotprompt contour). Pure
 *  data — the loader produces it; the project compiles it into a provenance-point
 *  native proc (it needs the infer capability + the `s/…` schema rosettas, which
 *  live in `makeEnv`, not here). See the `.prompt` resolver + `compileInferUnit`. */
export interface PromptUnit {
  /** The `.prompt` file's resolved path — the node's stable identity for the
   *  render (the card header shows it), and a future go-to-source anchor. */
  path: string;
  /** The DEFAULT model name from the frontmatter `model:`, or null if omitted.
   *  Model is materialization, not intent: a `.prompt` carries the prompt SHAPE
   *  (the intent), and the model is overridable at the call site via
   *  `:meta (dict :model …)`. Resolution is call-time `meta.model` ?? this ?? throw.
   *  Whatever resolves is passed straight to the backend; the provider config
   *  binds the name to an endpoint. */
  model: string | null;
  /** Compiled `(s/object …)` schema SOURCE (from Picoschema `output:`), or null
   *  for an unstructured prompt. Evaluated ONCE at compile time, not per call. */
  schemaSrc: string | null;
  /** `{{role}}`-split chat sections, in order. Each `source` is a handlebars
   *  template rendered per-call against the kwargs dict (boundaries fixed HERE,
   *  pre-interpolation — a rendered hole can't forge a new turn). */
  sections: { role: string; source: string }[];
  /** Server names from the frontmatter `mcp:` (a name or a list), or null. When present,
   *  the sealed proc runs AGENTICALLY — it lists those servers' tools, loops infer↔dispatch
   *  via `infer/agentic/end-to-end`'s engine, and returns the final answer. The defining
   *  surface for "an agent as a `.prompt`". Null ⇒ an ordinary single inference. */
  mcpServers: string[] | null;
}

/** What an extension resolver produces; the require rosetta executes it.
 *  - `load`       → `execExpr` each form into the run env (spill); require returns ⊥.
 *  - `eval`       → `execExpr` the forms, return the LAST value (e.g. an `.hbs` lambda).
 *  - `value`      → return the (plain, membrane-safe) value; the caller binds it
 *    explicitly with `(define x (require …))`. No spill into the global env —
 *    a data file's binding is as greppable and provenance-clear as an import.
 *  - `infer-unit` → a `.prompt`: the require rosetta hands the unit to the
 *    project's `compileInferUnit` and returns the resulting native proc. */
export type ResolverResult =
  | { kind: "load"; forms: SchemeForm[] }
  | { kind: "eval"; forms: SchemeForm[] }
  | { kind: "value"; value: unknown }
  | { kind: "infer-unit"; unit: PromptUnit };

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
      invariant(out.length !== 0, () => `require: path escapes the project root: ${p}`);
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
    invariant(CHAT_ROLES.has(next), () => `.chat.hbs: unknown role "${m[1]}" — use system, user, or assistant`);
    role = next;
    bodyStart = ROLE_MARKER.lastIndex;
  }
  invariant(role !== null, `.chat.hbs: no {{role "..."}} markers — a chat template needs at least one`);
  sections.push({ role, body: src.slice(bodyStart).trim() });
  return sections;
}

// ── .prompt (dotprompt) support ──────────────────────────────────────────────
//
// A `.prompt` file is a whole inference unit: YAML frontmatter (`model:` name +
// optional Picoschema `output:`) over a `{{role}}`-marked body. `(require)`ing
// one yields a lambda `(key . kv)` that RUNS infer/chat with the frontmatter
// model, the compiled output schema, and the rendered messages — so the verbose
// `s/object` schema blocks, the model name, and the (list (system…)(user…)) ceremony
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
  invariant(isPlainObject(node), ".prompt: output schema must be a map of fields");
  const fields = Object.entries(node).map(([k, v]) => compilePicoField(k, v));
  return `(s/object ${fields.join(" ")})`;
}

function scalarFieldSrc(name: string, type: string, desc: string): string {
  invariant(SCALAR_TYPES.has(type), () => `.prompt: unknown scalar type "${type}" for field "${name}"`);
  const d = desc ? ` ${JSON.stringify(desc)}` : "";
  return `(s/field/${type} ${JSON.stringify(name)}${d})`;
}

function compileElement(val: unknown): string {
  if (typeof val === "string") {
    const { type } = splitTypeDesc(val);
    invariant(SCALAR_TYPES.has(type), () => `.prompt: unknown array element type "${type}"`);
    return JSON.stringify(type);
  }
  if (isPlainObject(val)) return compilePicoschema(val);
  invariant(false, ".prompt: array element must be a scalar type or an object map");
}

function compilePicoField(rawKey: string, val: unknown): string {
  const m = rawKey.match(/^([A-Za-z_][\w-]*)(\??)(?:\(([^)]*)\))?$/);
  invariant(!!m, () => `.prompt: malformed schema key "${rawKey}"`);
  const name = m[1]!;
  invariant(!m[2], () => `.prompt: optional field "${name}" — optional schema fields aren't supported yet`);
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
  invariant(isPlainObject(fm), ".prompt: frontmatter must be a YAML map");
  return { fm, body: src.slice(m[0].length) };
}

/** Normalise the frontmatter `mcp:` to a server-name list (or null). Accepts a single name
 *  (`mcp: linear`) or a list (`mcp: [linear, github]`); every entry must be a string. */
function parsePromptMcp(raw: unknown, path: string): string[] | null {
  if (raw === undefined || raw === null) return null;
  const names = Array.isArray(raw) ? raw : [raw];
  for (const n of names) {
    if (typeof n !== "string") {
      invariant(false, () => `.prompt: "${path}" frontmatter \`mcp:\` must be a server name or a list of names`);
    }
  }
  return names as string[];
}

/** The default extension registry: `.scm` loads (spill), data files parse to a
 *  value (bound explicitly via `(define x (require …))`), `.txt` to a string,
 *  `.hbs` evaluates to a render lambda. */
export function defaultResolvers(): Map<string, ContentResolver> {
  const dataResolvers = Object.keys(DATA_PARSERS).map((ext): [string, ContentResolver] => [
    ext,
    (contents) => ({
      kind: "value",
      value: normalizeToJson(DATA_PARSERS[ext]!(String(contents))),
    }),
  ]);
  return new Map<string, ContentResolver>([
    // Pass the module path as `source` so a throw inside this file reads as
    // `path:line` in the scheme stack (L3). `.hbs` deliberately omits it — its
    // parsed forms are a synthetic `(lambda …)`, not the file's own content.
    [".scm", async (contents, { path }) => ({ kind: "load", forms: await parse(String(contents), undefined, path) })],
    ...dataResolvers,
    [".txt", (contents) => ({ kind: "value", value: String(contents) })],
    // `.hbs` evaluates to a SCHEME lambda (not a raw JS fn — membrane-safe): the
    // call site does `((require "x.hbs") args)` or `(define f (require "x.hbs"))`.
    [
      ".hbs",
      async (contents) => ({
        kind: "eval",
        forms: await parse(`(lambda args (template/handlebars ${JSON.stringify(String(contents))} args))`),
      }),
    ],
    // `.prompt` (dotprompt) is a SEALED inference unit — parsed HERE into a pure
    // `PromptUnit` descriptor (model name + Picoschema-compiled output schema + the
    // {{role}}-split body sections), then handed to the project's
    // `compileInferUnit`, which seals it into a provenance-point native proc.
    // `(define run-x (require "x.prompt"))` binds run-x to that proc; calling
    // `(run-x key :k v …)` renders + infers at JS level and traces as ONE node at
    // the real call site — no unwrapped line-1 `(infer/chat …)` lambda.
    //
    // Sections split HERE (trusted, pre-interpolation): a rendered hole value
    // containing `{{role "user"}}` lands as inert text in one section and can
    // never forge a turn. Longest-suffix resolution routes `*.prompt` here.
    [
      ".prompt",
      (contents, { path }) => {
        const { fm, body } = parsePromptFile(String(contents));
        // `model:` is an OPTIONAL default — model is materialization, supplied
        // (or overridden) at the call site via `:meta (dict :model …)`. A literal
        // here is the fallback; absent is fine as long as the call supplies one.
        const model = fm.model ?? null;
        invariant(model === null || typeof model === "string", '.prompt: frontmatter `model:` must be a model name string (e.g. "qwen3.5-9b") or omitted');
        const schemaSrc = fm.output === undefined ? null : compilePicoschema(fm.output);
        const sections = splitChatSections(body).map((s) => ({ role: s.role, source: s.body }));
        // `mcp:` (a name or a list of names) makes this an AGENTIC prompt. Normalise to a
        // string[] | null; each entry is a roster server name resolved at run time.
        const mcpServers = parsePromptMcp(fm.mcp, path);
        return { kind: "infer-unit", unit: { path, model, schemaSrc, sections, mcpServers } };
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
  /** Seals a `.prompt` `PromptUnit` into a callable native proc. Provided by the
   *  project (it closes over the infer capability + the `s/…` schema rosettas).
   *  Absent on a bare loader → requiring a `.prompt` throws (no infer to bind). */
  compileInferUnit?: (unit: PromptUnit) => MaybePromise<unknown>;
}): () => void {
  const { env, loader, tap, baseDir = "", compileInferUnit } = opts;
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
        const resolver = pickResolver(path, loader.resolvers);
        invariant(resolver, `require: no resolver for ${path}`);
        const result = await resolver(contents, { path });

        let value: unknown;
        if (result.kind === "value") {
          // Wrap JS→Scheme exactly as the old `json/parse` path did: arrays
          // become scheme LISTS (so `(length …)` works), plain objects become
          // SchemeJSObject (so `@`/`field` work). Pure value — `require` RETURNS
          // it for an explicit `(define x (require …))`; nothing is spilled.
          value = jsToLips(result.value);
        } else if (result.kind === "infer-unit") {
          // A `.prompt`: the project seals it into a provenance-point native proc.
          // require RETURNS the proc — bound via `(define run-x (require …))`,
          // called as one node at the real call site. A bare loader (no project)
          // has no infer to bind, so this is a hard error, not a silent ⊥.
          invariant(
            compileInferUnit,
            `require: "${path}" is a .prompt inference unit, but this loader has no infer capability — run it through a Project, not a bare loader.`,
          );
          value = await compileInferUnit(result.unit);
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
      invariant(loader.imports.has(name), () => {
        const known = [...loader.imports.keys()];
        return `import: unknown module "${name}" (registered: ${known.length > 0 ? known.join(", ") : "none"})`;
      });
      return loader.imports.get(name);
    },
  });
}
