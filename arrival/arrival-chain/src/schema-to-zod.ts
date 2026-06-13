import * as z from "zod";

import { tagToJsonSchema } from "@here.build/arrival-inference";

// ── schema DSL → zod bridge ────────────────────────────────────────────
//
// `(declare/expose …)` declares a function's input/output with the SAME
// `(s/object …)` tagged-list DSL the inference path already uses for structured
// outputs. To validate an HTTP request body against that signature, the SaaS
// needs a zod schema — but a hand-written second walk of the tagged list would
// be a *parallel* lowering that silently drifts from the JSON Schema the model
// receives (the renderer emits `additionalProperties:false` + all-required; a
// naive `z.object` would strip unknowns + diverge).
//
// So this is NOT a second recursion. It routes the tagged list through the ONE
// canonical lowering (`tagToJsonSchema`, shared with the OpenAI/Anthropic
// backends) and lets zod's own `z.fromJSONSchema` reconstruct the validator from
// that single JSON Schema. zod honors the two facts the renderer encodes:
//   • `additionalProperties:false`  ⇒  `.strict()`  (reject unknown keys)
//   • every prop in `required`      ⇒  all fields required (no implicit optionals)
// Bind zod to the same tag the model sees and the HTTP validator and the wire
// schema cannot drift — that is the whole point of the bridge.

/**
 * Lower a parsed schema-DSL tagged list (the canonical `(s/object …)` form, e.g.
 * `["object",["name","string"],["bucket",["enum","A","B"]]]`) into a zod schema.
 *
 * Goes tag → JSON Schema (the single shared `tagToJsonSchema` lowering) → zod
 * (`z.fromJSONSchema`). No parallel recursion over the tag, so the validator can
 * never disagree with the JSON Schema the inference backends emit.
 *
 * Objects come back `.strict()` (unknown keys rejected) with every declared
 * field required, mirroring the renderer's `additionalProperties:false` +
 * all-`required`. A bare primitive tag (`"string"`) lowers to the matching zod
 * primitive; an empty / unrecognised tag lowers to `z.any()`.
 */
export function schemaToZod(tag: unknown): z.ZodType {
  return z.fromJSONSchema(tagToJsonSchema(tag) as Parameters<typeof z.fromJSONSchema>[0]);
}

/**
 * Slot-string form, symmetric with `renderSchema`: parse the canonical
 * JSON-stringified tagged list (as stored in `exposedFunctions.declaredSig` /
 * the cache key's schema slot) and lower it to zod.
 *
 * Returns null for a null slot or a legacy non-JSON string marker — the same
 * "no structured schema here" signal `renderSchema` returns, so callers branch
 * once on null rather than guessing.
 */
export function schemaSlotToZod(schemaSlot: string | null): z.ZodType | null {
  if (!schemaSlot) return null;
  let tag: unknown;
  try {
    tag = JSON.parse(schemaSlot);
  } catch {
    return null; // legacy string marker — not a structured schema
  }
  return schemaToZod(tag);
}
