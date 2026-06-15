// loader-extensions — the file-type resolver registry behind `(require/register-extension)`.
//
// A file-type "extension" is not a verb-pack to assemble — it is a resolver, and the only
// thing it needs is a function `(contents, filepath) → value`. So registering one is just
// mutating a table, keyed by file-suffix → the NAME of the resolver verb that handles it.
//
// Two deliberate design choices (see docs/working-proposals/require-as-capability-and-
// prompt-support-2026-06-15.md §7):
//
//   • BY-NAME, late-bound per env. The table stores the resolver verb's NAME, not its value.
//     `require`, on hitting a `.X` file, looks the name up in the CURRENT env and calls it.
//     So a resource-armed resolver (`.prompt` → `prompt/compile`, which closes over the
//     infer resource) picks up the *calling* env's resource — no captured closure, no
//     cross-run leak in this process-global table — and an env that never rooted the owning
//     capability simply has no binding for the name, so requiring that extension errors.
//     Global vocabulary, per-scope capability.
//
//   • PRELUDE-ONLY registration (the interpreter nuance — read this before you're confused).
//     `require/register-extension` is bound ONLY while capability preludes evaluate
//     (bootstrap). Once the env is handed to user code it is replaced by a throwing stub via
//     {@link sealRegisterExtension}. A running program therefore CANNOT teach the loader a
//     new file type mid-run. This is not an oversight or a missing feature — it is the
//     wrong-state-impossible guarantee: a `.prompt`/`.hbs` resolver is a CAPABILITY GRANT
//     (it can run inference, read templates), not user data, so only a capability's prelude
//     may install one. If you are reading the interpreter and wondering why the verb
//     "disappears" after startup — this is why.

/** ext-suffix (e.g. `".prompt"`) → the NAME of the resolver verb that handles it. Process-
 *  global + idempotent: the same (suffix, name) re-registers as a no-op across runs (the
 *  same capabilities always register the same names); a DIFFERENT name for an already-claimed
 *  suffix is a conflict and throws. */
const RESOLVERS = new Map<string, string>();

/** Coerce a `(require/register-extension)` name argument (a quoted symbol `'handlebars/lambda`
 *  or a string) to the bound verb name. */
function resolverNameOf(raw: unknown): string {
  return typeof raw === "string" ? raw : String(raw);
}

/** Normalize a suffix to a leading-dot form (`"hbs"` and `".hbs"` both → `".hbs"`). */
function normalizeSuffix(ext: string): string {
  return ext.startsWith(".") ? ext : `.${ext}`;
}

/** Register a file-suffix → resolver-verb-name mapping. Idempotent for an identical mapping;
 *  a conflicting name for an already-registered suffix is a legible throw (never silent
 *  last-write-wins — two capabilities claiming `.hbs` differently is a real configuration
 *  bug). */
export function registerExtension(ext: unknown, resolverName: unknown): void {
  const suffix = normalizeSuffix(String(ext));
  const name = resolverNameOf(resolverName);
  const existing = RESOLVERS.get(suffix);
  if (existing !== undefined && existing !== name) {
    throw new Error(
      `require/register-extension: "${suffix}" is already handled by "${existing}", cannot reassign to "${name}". ` +
        `A file suffix maps to exactly one resolver; two capabilities are claiming it.`,
    );
  }
  RESOLVERS.set(suffix, name);
}

/** The resolver verb name for a path, by LONGEST matching suffix (so `.spec.json` can beat
 *  `.json`). Returns `undefined` when no registered extension matches — the caller decides
 *  whether that's an error or a fall-through to a builtin (`.scm`). */
export function lookupExtensionResolver(path: string): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const [suffix, name] of RESOLVERS) {
    if (path.endsWith(suffix) && suffix.length > bestLen) {
      best = name;
      bestLen = suffix.length;
    }
  }
  return best;
}

/** The bootstrap-only verb name. */
export const REGISTER_EXTENSION_VERB = "require/register-extension";

/** Minimal host the registrar binds onto — `Environment` satisfies it structurally. */
interface RegistrarHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- verb args are call-shape-checked at the boundary
  defineRosetta(name: string, config: { fn: (...args: any[]) => any; type?: string }): void;
  set(name: string, value: unknown): unknown;
}

/** Bind `require/register-extension` for the BOOTSTRAP phase. Call from the require
 *  capability so it is present while every capability's `prelude` evaluates. After assembly,
 *  {@link sealRegisterExtension} replaces it — see the prelude-only note at the top. */
export function defineRegisterExtensionRosetta(env: RegistrarHost): void {
  env.defineRosetta(REGISTER_EXTENSION_VERB, {
    type: "(suffix: SStr, resolver: unknown): unknown",
    fn: (suffix: unknown, resolverName: unknown) => {
      registerExtension(suffix, resolverName);
      return undefined;
    },
  });
}

/** Replace `require/register-extension` with a throwing stub once preludes are done — the
 *  enforcement half of the prelude-only guarantee (see the top-of-file note). Idempotent. */
export function sealRegisterExtension(env: RegistrarHost): void {
  env.set(REGISTER_EXTENSION_VERB, () => {
    throw new Error(
      `${REGISTER_EXTENSION_VERB} is bootstrap-only: a file-type resolver is a capability grant, ` +
        `not runtime data, so it can only be registered from a capability's prelude — not from a ` +
        `running program. (Add an extension by rooting a capability whose prelude registers it.)`,
    );
  });
}

/** Test-only: clear the process-global registry between cases. */
export function __resetExtensionRegistryForTest(): void {
  RESOLVERS.clear();
}
