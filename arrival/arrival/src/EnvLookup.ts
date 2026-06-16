// Lets callers distinguish "binding exists, value is undefined" from "not bound"
// (the latter returns undefined directly). NOT an AValue — deliberately outside
// the runtime value hierarchy.
export class EnvLookup<T = unknown> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  valueOf(): T {
    return this.value;
  }
}
