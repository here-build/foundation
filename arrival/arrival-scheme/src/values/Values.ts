// The carrier for `(values …)`: a distinct wrapper, not a plain value, so a
// multiple-values return is distinguishable from a single value that happens
// to be a collection.
export class Values {
  __values__: unknown[];

  // Use Values.from() — it unwraps 0/1-element cases this constructor cannot.
  private constructor(values: unknown[]) {
    this.__values__ = values;
  }

  /**
   * Empty → undefined; single element → that element unwrapped; ≥2 → a Values.
   * The unwrap is what keeps a 1-value `(values x)` indistinguishable from `x`.
   */
  static from(values: unknown[]): unknown {
    if (values.length === 0) {
      return undefined;
    }
    if (values.length === 1) {
      return values[0];
    }
    return new Values(values);
  }

  toString(): string {
    return this.__values__.map((x) => String(x)).join("\n");
  }

  valueOf(): unknown[] {
    return this.__values__;
  }
}
