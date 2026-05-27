import { AValue, EMPTY_PROVENANCE } from "./AValue.js";

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
}

export const schemeTrue = new SchemeBool(true);
export const schemeFalse = new SchemeBool(false);

// Reuse singletons on the empty-provenance fast path; allocate only when stamped.
AValue.registerBoxer("boolean", (v, p) =>
  p === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new SchemeBool(v as boolean, p),
);
