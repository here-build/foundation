// -------------------------------------------------------------------------
// Lips Exception used in error function
// -------------------------------------------------------------------------

import type { SchemeValue } from "./types.js";

export class LipsError extends Error {
  static __class__ = "lips-error";

  args: SchemeValue;

  constructor(message: string, args?: SchemeValue) {
    super(message);
    this.name = "LipsError";
    this.args = args;
  }
}
