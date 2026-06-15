/**
 * The runtime half of `(define/mcp name :description … :aliases '(…) <handler>)` — the
 * superpowered-define sibling that declares an MCP CATALOG PRIMITIVE inline in Scheme.
 *
 * Same shape/posture as `declare/expose` (see `expose.ts`): an authoring preamble macro
 * (`define/mcp`, see project.ts `SUPERDEFINE_PREAMBLE`) lowers to a plain `define` over this
 * rosetta, so the interpreter core only ever sees `define` + an ordinary call — no MCP concept
 * leaks into the pure dataflow core (the membrane rule). The name binds and is callable in-program
 * normally; the "superpower" is additive, host-side: the rosetta ALSO hands a typed
 * {@link McpDeclaration} to the host (an `McpEnvCapability` collecting its prelude's catalog) and
 * returns the handler so the same verb is usable in the same program.
 *
 *   (define/mcp transfer-gate
 *     :description "Canonical cross-species licensing gate — refusal-as-data."
 *     :aliases '(get-transfer-licensing transfer-eligibility can-transfer?)
 *     (lambda (q) …))
 *     ⇒ (define transfer-gate
 *          (mcp/declare "transfer-gate" :description "…" :aliases '(…) :handler (lambda (q) …)))
 *
 * `:aliases` is a quoted symbol (or string) list; it rides in the descriptor so the catalog +
 * undocumented alias bindings are derived from ONE inline declaration — unifying with how JS-symbol
 * primitives carry `aliases` in their `McpAnnotation`. Catalog-INVISIBLE: aliases bind, never list.
 *
 * "Capability optional, verb always present": with no `onMcp` sink the form still evaluates and
 * returns its handler — it just registers nowhere. Same posture as `onExpose`/`onOverridable`.
 */
import type { Environment } from "@here.build/arrival-scheme";
import invariant from "tiny-invariant";

/** The form head the preamble macro lowers to. */
export const MCP_FORM = "mcp/declare";

/** A scheme proc as seen from JS after crossing the rosetta membrane. The handler lambda is this. */
type SchemeProc = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * A live MCP-primitive declaration, handed to the host the moment the form evaluates. The host (an
 * `McpEnvCapability` lowering a prelude) keys these by `name`, folds `description` into its catalog
 * (`allAnnotations`), and binds each `aliases` entry to the same `handler` (catalog-invisible).
 */
export interface McpDeclaration {
  /** The primitive's name — its catalog identity and the binding the program calls. */
  name: string;
  /** One-line catalog description (may carry inline DIY `(define …)` scaffolding), or null. */
  description: string | null;
  /** Extra names the verb is ALSO bound under — same fn, never cataloged (undocumented shorthands). */
  aliases: string[];
  /** The verb itself — the handler proc the name binds to (callable in-program). */
  handler: SchemeProc;
}

/** Host sink for evaluated declarations. Sync or async; return ignored — the form's value is the
 *  handler. Absent ⇒ the verb binds but registers in no catalog. */
export type OnMcp = (decl: McpDeclaration) => void | Promise<void>;

/** Coerce a membraned string-ish (JS string or `{__string__}`) to a plain string, or null. */
function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "__string__" in v) return String((v as { __string__: unknown }).__string__);
  return null;
}

/** Normalize an `:aliases` value — a quoted symbol/string list that crosses as a JS array OR a
 *  Pair-chain OR symbol-objects (`{__name__}`) — to plain strings. Defensive across membrane shapes. */
function aliasNames(v: unknown): string[] {
  const out: string[] = [];
  const push = (x: unknown): void => {
    if (typeof x === "string") out.push(x);
    else if (x && typeof x === "object" && "__name__" in x) {
      const n = (x as { __name__: unknown }).__name__;
      out.push(typeof n === "string" ? n : String(n));
    } else {
      const s = asString(x);
      if (s !== null) out.push(s);
    }
  };
  if (Array.isArray(v)) v.forEach(push);
  else if (v && typeof v === "object" && "car" in v) {
    let cur = v as { car: unknown; cdr: unknown };
    while (cur && typeof cur === "object" && "car" in cur) {
      push(cur.car);
      cur = cur.cdr as { car: unknown; cdr: unknown };
    }
  }
  return out;
}

/**
 * Register the `mcp/declare` rosetta on `env`. Reuses the host's `buildDict` folder so
 * `:description`/`:aliases`/`:handler` resolve identically to every other `:k v` kwarg site, exactly
 * like `defineExposeRosetta`. `onMcp` is optional (capability-optional posture).
 */
export function defineMcpRosetta(opts: {
  env: Environment;
  /** Fold `:k v …` call args into a record (the project's `buildDict`). */
  buildDict: (args: unknown[]) => Record<string, unknown>;
  /** Host sink. Optional — omit to make the form a pure (registering-nowhere) handler factory. */
  onMcp?: OnMcp;
}): void {
  const { env, buildDict, onMcp } = opts;

  env.defineRosetta(MCP_FORM, {
    fn: async (name: unknown, ...kv: unknown[]) => {
      invariant(
        typeof name === "string",
        () => `${MCP_FORM}: name must be a string, got ${name === null ? "null" : typeof name}`,
      );
      const folded = buildDict(kv);
      const handlerProc = folded.handler;
      invariant(
        typeof handlerProc === "function",
        () => `${MCP_FORM}: "${name}" is missing a :handler (lambda …)`,
      );

      if (onMcp) {
        await onMcp({
          name,
          description: asString(folded.description),
          aliases: aliasNames(folded.aliases),
          handler: handlerProc as SchemeProc,
        });
      }

      // The form's value IS the handler (a scheme-callable proc), so a program can both declare AND
      // use the primitive in the same draft.
      return handlerProc;
    },
  });
}
