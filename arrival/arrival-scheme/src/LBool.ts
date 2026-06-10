import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markAsSandboxBoundary } from "./sandbox-boundary.js";

export class SchemeBool extends AValue {
  static __class__ = "boolean";
  readonly kind = "bool" as const;

  constructor(
    public readonly value: boolean,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  toString(): string {
    return this.value ? "#t" : "#f";
  }
  valueOf(): boolean {
    return this.value;
  }
  toJs(): boolean {
    return this.value;
  }
  withProvenance(p: ReadonlySet<number>): SchemeBool {
    return new SchemeBool(this.value, p);
  }

  // Fantasy Land Setoid: total over any input, guards on the brand first.
  ["fantasy-land/equals"](other: unknown): boolean {
    return other instanceof SchemeBool && this.value === other.value;
  }
}

export const schemeTrue = new SchemeBool(true);
export const schemeFalse = new SchemeBool(false);

// Reuse singletons on the empty-provenance fast path; allocate only when stamped.
AValue.registerBoxer("boolean", (v, p) =>
  p === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new SchemeBool(v as boolean, p),
);

// ============================================================================
// SANDBOX BOUNDARY
// ============================================================================
// War story (2026-05-28 audit): SchemeBool's prototype is narrow today but
// the boundary marker still matters — the singletons `schemeTrue` and
// `schemeFalse` are heavily reused, so any future helper grafted onto
// SchemeBool.prototype reaches every Boolean-valued response from the
// sandbox. Mark now so the surface stays empty by default.
// ============================================================================
markAsSandboxBoundary(SchemeBool);
