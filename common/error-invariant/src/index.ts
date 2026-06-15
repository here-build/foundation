// Global `Error.invariant` — a side-effect import installs the assertion helper.
//
//   import "@here.build/error-invariant";
//   Error.invariant(cond, "message");      // throws Error when !cond
//   TypeError.invariant(cond, "message");  // throws TypeError
//   MyError.invariant(cond, "message");    // throws MyError
//
// One assignment covers every error class because the native (and user) error
// constructors inherit from `Error` through the ctor prototype chain, so the method
// resolves on any of them. The thrown class is the RECEIVER (`new this(...)`), not a
// hardcoded type — `MyError.invariant(...)` must throw a `MyError`, otherwise the
// receiver's type is silently lowered to a generic error and the catch-site loses the
// bit that told it which failure this was. Receivers therefore must take a message as
// their first constructor argument; classes with structured constructors (e.g. Plexus
// errors) carry their own `static invariant` over `ConstructorParameters` instead.
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
    invariant(this: ErrorConstructor, condition: any, message?: string | (() => string)): asserts condition;
  }
}

Error.invariant = function invariant(
  this: ErrorConstructor,
  condition: any,
  message?: string | (() => string),
): asserts condition {
  if (condition) {
    return;
  }
  // The receiver constructor when called as `X.invariant(...)`; fall back to TypeError
  // if the helper was pulled off `Error` and invoked unbound (`this` no longer a ctor).
  const Ctor: ErrorConstructor = typeof this === "function" ? this : TypeError;
  if (isProduction) {
    throw new Ctor(prefix);
  }
  const provided: string | undefined = typeof message === "function" ? message() : message;
  const value: string = provided ? `${prefix}: ${provided}` : prefix;
  throw new Ctor(value);
};

export {};
