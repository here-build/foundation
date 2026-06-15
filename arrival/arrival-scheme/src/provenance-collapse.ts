// Provenance for value-COLLAPSING ops — the canonical home for `string-append` /
// `join` lineage.
//
// Most ops preserve structure, so provenance rides along for free: `cons`/`list`
// keep each element an `AValue` member the trace can still walk, and value→value
// ops stamp via `withInputProvenance` (AValue.ts). The COLLAPSING ops are the
// exception: `string-append` and `join` fold a (possibly nested) structure of
// inference-stamped values down to ONE flat string, destroying the members the
// trace would otherwise walk. Without re-stamping, a prompt hole fed by
// `(join "\n" (map :reaction personas))` shows NO edge back to any persona —
// field-to-field wiring silently breaks, and the provenance graph sift/MCP stand
// on loses granularity it cannot recover.
//
// `collapseProvenance` is the sound fix: DEEP-walk the inputs and union the
// EXISTING point ids of every reachable `AValue` (never minting fresh ids, so it
// stays idempotent under loop accumulation). It must be COMPLETE over the
// structured carriers — a gap is a silent provenance hole:
//   • `Pair`        — list spines (`car`/`cdr`)
//   • `SchemeVector`— elements (the vector itself does NOT stamp from its members)
//   • `SchemeJSArray`— the lazy JS-array wrapper's `source` (the wrapper is NOT an
//                      AValue, so its elements are invisible to a flat union)
//   • raw JS `Array`— elements
// A value's OWN provenance is collected for ANY `AValue` (so a bare SchemeString
// input carries its lineage). Foreign-object (`SchemeJSObject`) MEMBERS are not
// walked — a dict's own point is collected, but stringifying a dict directly is
// not a wiring path; access a member first.

import { AValue } from "./values/AValue.js";
import { Pair } from "./values/Pair.js";
import { SchemeVector } from "./values/SchemeVector.js";
import { SchemeJSArray } from "./membrane.js";
import { SchemeString } from "./values/SchemeString.js";

/** Union the provenance point-ids of every AValue reachable in `vals`, deep-walking
 *  the structured carriers (list spines, vectors, arrays). Idempotent: only existing
 *  ids, never fresh ones. */
export function collapseProvenance(...vals: unknown[]): Set<number> {
  const acc = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof AValue) for (const p of v.provenance) acc.add(p);
    if (v instanceof Pair) {
      walk(v.car);
      walk(v.cdr);
    } else if (v instanceof SchemeVector) {
      for (const el of v.__vector__) walk(el);
    } else if (v instanceof SchemeJSArray) {
      for (const el of v.source) walk(el);
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    }
  };
  for (const v of vals) walk(v);
  return acc;
}

/** Re-stamp a collapsed string with provenance — a provenance-carrying `SchemeString`
 *  when there is lineage to carry, else the bare string (no empty wrapper churn). */
export function taintString(result: string, prov: Set<number>): string | SchemeString {
  return prov.size > 0 ? new SchemeString(result, prov) : result;
}
