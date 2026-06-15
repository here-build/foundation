// Wraps a Promise so it travels through Scheme code as an opaque value instead
// of being auto-forced, letting `(quote …)` survive an async boundary.
import invariant from "tiny-invariant";
import { is_function } from "./guards.js";
import type { SchemeValue } from "./types.js";
import { type } from "./utils/typecheck.js";

export class QuotedPromise {
  static __class__ = "promise";
  static pending_str = "#<js-promise (pending)>";
  static rejected_str = "#<js-promise (rejected)>";

  declare _promise: Promise<SchemeValue>;
  declare __promise__: Promise<SchemeValue | void>;
  declare __pending__: boolean;
  declare __rejected__: boolean;
  declare __fulfilled__: boolean;
  declare __reason__: unknown;
  declare __type__: string | undefined;
  // prevent resolving when returned from real promise #153
  // instance property shadows the prototype method
  then: false = false;

  constructor(promise: Promise<SchemeValue>) {
    const internal = {
      pending: true,
      rejected: false,
      fulfilled: false,
      reason: undefined as unknown,
      type: undefined as string | undefined,
    };
    // then added to __promise__ is needed otherwise rejection
    // will give UnhandledPromiseRejectionWarning in Node.js
    let trackedPromise: Promise<SchemeValue | void> = promise.then((v) => {
      internal.type = type(v);
      internal.fulfilled = true;
      internal.pending = false;
      return v;
    });
    // promise without catch, used for valueOf - for rejecting
    // that should throw an error when used with await
    Object.defineProperty(this, "_promise", {
      value: trackedPromise,
      configurable: true,
      enumerable: false,
    });
    if (is_function(trackedPromise.catch)) {
      // prevent exception on unhandled rejecting when using
      // '>(Promise.reject (new Error "zonk")) in REPL
      trackedPromise = trackedPromise.catch((error: unknown) => {
        internal.rejected = true;
        internal.pending = false;
        internal.reason = error;
      });
    }
    for (const name of Object.keys(internal)) {
      Object.defineProperty(this, `__${name}__`, {
        enumerable: true,
        get: () => internal[name as keyof typeof internal],
      });
    }
    Object.defineProperty(this, "__promise__", {
      value: trackedPromise,
      configurable: true,
      enumerable: true,
    });
  }

  catch(fn: (err: unknown) => SchemeValue): QuotedPromise {
    return new QuotedPromise(this.valueOf().catch(fn));
  }

  valueOf(): Promise<SchemeValue> {
    invariant(this._promise, "QuotedPromise: invalid promise created");
    return this._promise;
  }

  toString(): string {
    if (this.__pending__) {
      return QuotedPromise.pending_str;
    }
    if (this.__rejected__) {
      return QuotedPromise.rejected_str;
    }
    return `#<js-promise resolved (${this.__type__})>`;
  }
}

// The then method is on the prototype but shadowed by instance property `then = false`
// to prevent Promise auto-resolution. Code can access it via prototype when needed.
Object.defineProperty(QuotedPromise.prototype, "then", {
  value(this: QuotedPromise, fn: (v: SchemeValue) => SchemeValue): QuotedPromise {
    return new QuotedPromise(this.valueOf().then(fn));
  },
  writable: true,
  configurable: true,
});
