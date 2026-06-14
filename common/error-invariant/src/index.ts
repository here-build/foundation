// Global `Error.invariant` — a side-effect import installs the assertion helper.
//
//   import "@here.build/error-invariant";
//   Error.invariant(cond, "message");      // throws TypeError when !cond
//   TypeError.invariant(cond, "message");  // SAME fn — reached because the native error
//                                          // constructors inherit from `Error` (ctor prototype
//                                          // chain), so one assignment covers them all.
//
// Extracted from arrival-scheme/sandbox-boundary.ts so the assertion helper is a
// standalone foundation, not a side effect of the sandbox layer.
//
// `process.env.NODE_ENV` is read once at install time: in production the message is
// dropped (constant string, no closure call); bundlers static-replace it in the browser.

const isProduction: boolean = process.env.NODE_ENV === "production";
const prefix: string = "Invariant failed";

declare global {
  interface ErrorConstructor {
    invariant(condition: any, message?: string | (() => string)): asserts condition;
  }
}

Error.invariant = function invariant(condition: any, message?: string | (() => string)): asserts condition {
  if (condition) {
    return;
  }
  if (isProduction) {
    throw new TypeError(prefix);
  }
  const provided: string | undefined = typeof message === "function" ? message() : message;
  const value: string = provided ? `${prefix}: ${provided}` : prefix;
  throw new TypeError(value);
};

export {};
