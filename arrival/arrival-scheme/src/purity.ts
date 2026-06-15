// Purity doors — the typed throw behind every omitted feature.
//
// arrival is PURE DATAFLOW, not general Scheme. Two whole families are omitted
// by design — DYNAMICS (call/cc, dynamic-wind, make-parameter/parameterize,
// delay/force) and WRITING METHODS (set-car!/set-cdr!/append!, vector/string/
// bytevector mutators). Both falsify provenance: arrival's reason to exist is
// value-level lineage (every value carries a provenance set the MCP/trace engine
// reads), and lineage is sound only if values are immutable and evaluation is
// pure. These are not missing features — they are what HAD to be excluded.
//
// The omission LIST is declared in bootstrap.ts as a manifesto of `define-macro`
// doors (see the "PURITY" block there). Each door expands to a `(%purity-door
// feature reason alternative)` call; the `%purity-door` stdlib primitive routes
// here. This module owns only the TYPED throw — a PurityError carrying the
// feature as an internal routing/telemetry key (errors-as-doors Rule 3/5) — so
// the language owns the list and the host owns the structured error.

import { ArrivalError } from "./ArrivalError.js";

export class PurityError extends ArrivalError {
  static __class__ = "purity-error";
  readonly owner = "owned-by/purity-invariant";

  constructor(
    message: string,
    /** The omitted feature, e.g. "set-cdr!" — internal routing/telemetry key. */
    public readonly feature: string,
  ) {
    super(message);
    this.name = "PurityError";
  }
}

/**
 * Throw a teaching door for a deliberately-omitted feature: deny + name the
 * reason (purity/provenance) + route to the supported alternative.
 *
 * @param feature     the name the caller reached for (e.g. `"vector-set!"`)
 * @param reason      why it is omitted (the provenance/purity concern)
 * @param alternative the supported channel to use instead
 */
export function purityDoor(feature: string, reason: string, alternative: string): never {
  throw new PurityError(`${feature} is omitted from arrival by design.\n  Why: ${reason}\n  Instead: ${alternative}`, feature);
}
