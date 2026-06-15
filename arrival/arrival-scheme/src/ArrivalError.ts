// -------------------------------------------------------------------------
// Arrival Exception — base class for error function and Scheme-level errors
// -------------------------------------------------------------------------

import type { SchemeValue } from "./types.js";

export class ArrivalError extends Error {
  static __class__ = "arrival-error";

  args: SchemeValue;

  constructor(message: string, args?: SchemeValue) {
    super(message);
    this.name = "ArrivalError";
    this.args = args;
  }
}
