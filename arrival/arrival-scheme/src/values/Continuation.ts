import invariant from "tiny-invariant";

export class Continuation {
  constructor(public __value__: any) {}

  invoke() {
    invariant(this.__value__ !== null, "Continuations are not implemented yet");
  }
}
