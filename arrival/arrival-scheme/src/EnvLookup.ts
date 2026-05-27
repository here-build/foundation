// Lets callers distinguish "binding exists, value is undefined" from "not bound"
// (the latter returns undefined directly). NOT an AValue — deliberately outside
// the runtime value hierarchy.
export class EnvLookup<T = unknown> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  static isUndefined(x: unknown): boolean {
    return x instanceof EnvLookup && x.value === undefined;
  }

  valueOf(): T {
    return this.value;
  }
}
