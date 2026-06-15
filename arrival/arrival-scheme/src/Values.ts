// The carrier for `(values …)`: a distinct wrapper, not a plain value, so a
// multiple-values return is distinguishable from a single value that happens
// to be a collection.
export class Values {
  __values__: unknown[];

  // Private constructor - use Values.from() factory instead
  private constructor(values: unknown[]) {
    this.__values__ = values;
  }

  /**
   * Factory method to create Values or unwrap single/empty values.
   * - Empty array: returns undefined
   * - Single element: returns that element (unwrapped)
   * - Multiple elements: returns Values instance
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
