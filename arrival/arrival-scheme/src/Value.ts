// -------------------------------------------------------------------------
// Value returned in lookup if found value in env and in promise_all
// -------------------------------------------------------------------------
export class Value<T = unknown> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  static isUndefined(x: unknown): boolean {
    return x instanceof Value && x.value === undefined;
  }

  valueOf(): T {
    return this.value;
  }
}
