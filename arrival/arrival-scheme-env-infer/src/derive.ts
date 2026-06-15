// @here.build/arrival-scheme-env-infer/derive — the entity / derive ALGEBRA as a capability.
//
// The scheme-facing surface of the derive-entity algebra (which lives, kind-agnostic, in
// arrival-inference). These verbs are PURE value constructors + transforms — they build and
// derive `DerivableEntity` values, touch no resolver, take no config:
//
//   (mcp :name) / (llm :name)     → opaque entity getters (connection-as-value)
//   (llm/with base :k v …)        → bind content params to an (llm …)
//   (derive base :method handler) → install observe-only middleware (kind-agnostic)
//   (mcp/define name :method h …) → fabricate an mcp entity from handlers
//   mcp/break                     → the halt sentinel (a bound value)
//
// This is the dependency floor of the inference cluster: both `arrival/infer` (for `llm`) and the
// dispatch pack `arrival/mcp` (for `mcp` / `derive`) `deps` on it. The split is meaningful — the
// verbs HERE touch no resolver and take no config, so they can be rooted alone; the dispatch verbs
// (`mcp/call` / `mcp/list`), which DO need the credentialed resolver, stay in ./mcp.

import { EnvCapability } from "@here.build/arrival-scheme/capability";
import {
  DerivableEntity,
  type EntityMiddleware,
  LLM_PARAM_TYPES,
  type LlmParams,
  MCP_BREAK,
  type McpDefinedMethod,
} from "@here.build/arrival-inference";
import invariant from "tiny-invariant";

/** The brand arrival-scheme stamps on a keyword's accessor function. A global registered symbol
 *  (Symbol.for), so it's reconstructable here without importing it across the package boundary. */
const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival-scheme/keyword-accessor-field");

/** Coerce a server/param-name argument to its string name. A keyword (`:linear`) evaluates
 *  to a branded accessor function carrying its field; a string/symbol stringifies directly. */
export function serverNameOf(raw: unknown): string {
  if (typeof raw === "function") {
    const field = (raw as unknown as Record<symbol, unknown>)[KEYWORD_ACCESSOR_FIELD];
    if (typeof field === "string") return field;
  }
  return String(raw);
}

/** Validate + coerce one `(llm/with …)` value to its declared param type. A wrong type is a
 *  legible throw — never a silent coerce of `:temperature "hot"`, never storing `:system #f`. */
function coerceLlmParam(key: string, value: unknown, expected: "number" | "string"): unknown {
  if (expected === "number") {
    invariant(typeof value === "number" && Number.isFinite(value), `llm/with: :${key} must be a number`);
    return value;
  }
  invariant(
    value != null && typeof value !== "number" && typeof value !== "boolean" && typeof value !== "function",
    `llm/with: :${key} must be a string`,
  );
  return String(value);
}

/** The entity/derive algebra verbs. No config, no resolver — pure value constructors over
 *  the arrival-inference derive algebra. `deps` of both the infer pack (for `llm`) and the
 *  mcp dispatch pack (for `mcp` / `derive`). */
export const arrivalDeriveCapability = new EnvCapability("arrival/derive", {
  symbols: {
    // (mcp :name) / (llm :name) — the opaque entity getters; `kind` is the only kind-aware
    // bit (it picks the honest bottom at dispatch). Everything downstream is kind-agnostic.
    mcp: {
      type: "(name: unknown): unknown",
      fn: (name: unknown) => new DerivableEntity("mcp", serverNameOf(name)),
    },
    llm: {
      type: "(name: unknown): unknown",
      fn: (name: unknown) => new DerivableEntity("llm", serverNameOf(name)),
    },
    // (llm/with base :temperature 0.7 :system "…") — bind CONTENT params (cache-affecting)
    // to an (llm …). Typed-not-bag: an unknown :keyword or wrong-typed value is a legible error.
    "llm/with": {
      type: "(base: unknown, ...pairs: unknown[]): unknown",
      fn: (base: unknown, ...pairs: unknown[]) => {
        invariant(base instanceof DerivableEntity, "llm/with: first arg must be an (llm …) entity");
        invariant(base.kind === "llm", `llm/with: base must be an (llm …), got kind "${base.kind}"`);
        invariant(pairs.length % 2 === 0, "llm/with: expects an (llm …) then :key value pairs");
        const patch: Record<string, unknown> = {};
        for (let i = 0; i < pairs.length; i += 2) {
          const key = serverNameOf(pairs[i]);
          const expected = (LLM_PARAM_TYPES as Record<string, "number" | "string" | undefined>)[key];
          invariant(
            expected !== undefined,
            `llm/with: unknown param ":${key}" — allowed: ${Object.keys(LLM_PARAM_TYPES).join(", ")}`,
          );
          patch[key] = coerceLlmParam(key, pairs[i + 1], expected);
        }
        return base.withParams(patch as Partial<LlmParams>);
      },
    },
    // (derive base :method handler) — the KIND-AGNOSTIC interception primitive: install an
    // observe-only middleware on ANY entity, returning a NEW entity (immutable derive).
    derive: {
      type: "(base: unknown, method: unknown, handler: unknown): unknown",
      fn: (base: unknown, method: unknown, handler: unknown) => {
        invariant(
          base instanceof DerivableEntity,
          "derive: first arg must be a derivable entity (from (mcp …) / (llm …))",
        );
        invariant(typeof handler === "function", "derive: handler must be a (req next progress) lambda");
        return base.withMiddleware({
          method: serverNameOf(method),
          handler: handler as EntityMiddleware["handler"],
        });
      },
    },
    // (mcp/define name :method handler …) — fabricate an mcp entity whose methods ARE the
    // handlers (no credentialed backend). The mock / what-if-a-server primitive.
    "mcp/define": {
      type: "(name: unknown, ...pairs: unknown[]): unknown",
      fn: (name: unknown, ...pairs: unknown[]) => {
        invariant(pairs.length % 2 === 0, "mcp/define: expects a name then :method handler pairs");
        const defined: Partial<Record<string, McpDefinedMethod>> = {};
        for (let i = 0; i < pairs.length; i += 2) {
          const method = serverNameOf(pairs[i]);
          invariant(typeof pairs[i + 1] === "function", `mcp/define: handler for ${method} must be a (req) lambda`);
          defined[method] = pairs[i + 1] as McpDefinedMethod;
        }
        return new DerivableEntity("mcp", serverNameOf(name), [], defined);
      },
    },
    // mcp/break — the halt sentinel a middleware returns to stop an agentic loop. A bound
    // VALUE (the global registered symbol), so scheme's `mcp/break` and the JS chain runner
    // compare `===` across the membrane.
    "mcp/break": { value: MCP_BREAK },
  },
});
