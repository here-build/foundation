/**
 * The runtime half of `(declare/expose …)` — the "sealed skill" form.
 *
 * Where `extractExpose` reads a declaration's SIGNATURE statically (parse only,
 * handler never runs — the config-plane sync path), this is what happens when a
 * program actually EVALUATES the form: it captures the input/output schemas and
 * the handler closure, hands a typed `ExposeDeclaration` to the host (its
 * registry), and returns the handler so the same function is callable in-program.
 *
 * `(declare/expose "classify-ticket"
 *    :input  (s/object (s/field/string "message"))
 *    :output (s/object (s/field/string "label") (s/field/number "confidence"))
 *    :handler (lambda (input) …))`
 *
 * The schema args evaluate (via the `s/…` preamble rosettas already on the env)
 * to canonical tagged lists — the SAME shape `extractExpose` slices as source
 * and the SAME shape the picoschema/`schema→zod` lowering consumes — so the
 * static and runtime views can never describe different contracts.
 *
 * The handler crosses the rosetta membrane as a plain async callable (a scheme
 * `(lambda …)` is a JS function on the far side). The wrapper lets the host call
 * `decl.handler(jsInput)` and get a plain JS value back (it applies
 * the LIPS→JS membrane on the result) — the host layers zod validation on top;
 * keys/credentials are never in scope here (this module touches neither).
 *
 * Injection mirrors `infer: InferFn`: `buildArrivalEnv` takes an optional
 * `onExpose` sink. When the host omits it, the form still evaluates and returns
 * the handler (usable in-program) — it just isn't registered anywhere. Same
 * "capability is optional, the verb always exists" posture as `import`/`require`.
 */
import { schemeToJs } from "@here.build/arrival-scheme";
import type { Environment } from "@here.build/arrival-scheme";
import invariant from "tiny-invariant";

import { EXPOSE_FORM } from "./extract-expose.js";

/** A scheme proc as seen from JS after crossing the rosetta membrane: an async
 *  callable taking already-membraned JS args. The handler lambda is exactly this. */
type SchemeProc = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * A live exposed-function declaration, handed to the host the moment the form
 * evaluates. The host keys these by `name`, lowers the schemas to its
 * own validators, and gates/invokes `handler` behind auth + the wallet.
 */
export interface ExposeDeclaration {
  /** The exposed function's name — its project-global identity and registry key
   *  (both the `define/exposed` front and legacy `declare/expose` key by name). */
  name: string;
  /** Canonical `(s/object …)` tagged list for the input, or null when the
   *  declaration omits `:input`. Identical in shape to `extractExpose`'s sliced
   *  `inputSrc` once evaluated, and to a `.prompt`'s compiled schema. */
  inputSchema: unknown | null;
  /** Canonical `(s/object …)` tagged list for the output, or null. */
  outputSchema: unknown | null;
  /** Canonical `(s/object …)` tagged list for the declared, typed, FILTERABLE
   *  observability dimensions (low-cardinality `:meta`), or null. Same schema
   *  shape as input/output; becomes the runs-filter surface host-side. */
  metaSchema: unknown | null;
  /**
   * The handler. Call with a plain JS input; get a plain JS value back (the
   * wrapper crosses the result through the LIPS→JS membrane). Async because the
   * underlying scheme proc may itself `(infer …)`. Validation/typing is the
   * host's job — this is the raw bridge.
   */
  handler: (input: unknown) => Promise<unknown>;
}

// Source location is NOT carried on the runtime declaration: by the time the
// form evaluates, the handler is a plain JS closure and the `(lambda …)` form's
// `__location__` is gone. Location truth lives on the STATIC `extractExpose`
// entry (the config-plane sync path); the host correlates the two views by
// `name`, which is the registry key anyway. No best-effort field that's almost
// always undefined (model-design: no speculative dead state).

/** Host sink for evaluated declarations. Sync or async; its return is ignored —
 *  the form's value is always the handler. */
export type OnExpose = (decl: ExposeDeclaration) => void | Promise<void>;

/**
 * Register the `declare/expose` rosetta on `env`. Reuses the host's `dictKey`
 * (keyword→bare-field) + `buildDict` folder so `:input`/`:output`/`:handler`
 * resolve identically to every other `:k v` kwarg site (`dict`, the `.prompt`
 * proc). The rosetta is `withContext` purely to read the form's location off
 * the current invocation when available; it is NOT a provenance point — the
 * declaration is a registration, not a value-producing node.
 *
 * `dictKey`/`buildDict` are passed in (rather than imported) to avoid a cycle:
 * they live in project.ts next to `buildArrivalEnv`, which owns this wiring.
 */
export function defineExposeRosetta(opts: {
  env: Environment;
  /** Fold `:k v …` call args into a record, recovering bare field names from
   *  keyword pluck-accessors. The project's `buildDict`. */
  buildDict: (args: unknown[]) => Record<string, unknown>;
  /** Host sink. Optional — omit to make the form a pure (registering-nowhere)
   *  handler factory. */
  onExpose?: OnExpose;
}): void {
  const { env, buildDict, onExpose } = opts;

  // ── `declare/expose` — the one expose rosetta ─────────────────────────
  // The `define/exposed` authoring front is now a pure preamble macro that
  // lowers directly to `(define name (declare/expose (symbol->string 'name)
  // …passthrough :k v… :handler <body>))`, so there is no separate runtime
  // head: both fronts land here, keyed by name, on the same `onExpose` sink.
  env.defineRosetta(EXPOSE_FORM, {
    fn: async (name: unknown, ...kv: unknown[]) => {
      invariant(
        typeof name === "string",
        () => `${EXPOSE_FORM}: name must be a string, got ${name === null ? "null" : typeof name}`,
      );
      const folded = buildDict(kv);
      const handlerProc = folded.handler;
      invariant(
        typeof handlerProc === "function",
        () => `${EXPOSE_FORM}: "${name}" is missing a :handler (lambda (input) …)`,
      );

      // The handler crosses back as a JS callable. Wrap it so the host hands in
      // plain JS and receives plain JS — the scheme proc's result is run through
      // the LIPS→JS membrane. (The proc is async-capable; await it.)
      const proc = handlerProc as SchemeProc;
      const handler = async (input: unknown): Promise<unknown> => schemeToJs(await proc(input), {});

      if (onExpose) {
        await onExpose({
          name,
          inputSchema: folded.input ?? null,
          outputSchema: folded.output ?? null,
          metaSchema: folded.meta ?? null,
          handler,
        });
      }

      // The form's value IS the handler (still a scheme-callable proc), so a
      // program can both expose AND use the function in the same draft.
      return handlerProc;
    },
  });
}
