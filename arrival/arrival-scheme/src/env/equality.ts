/**
 * Equality / identity predicates pack.
 *
 * Holds the R7RS equivalence-and-identity predicates extracted verbatim from
 * the interpreter's `wrappedOps` hot path: `boolean=?` and `symbol=?` (typed
 * equivalence over the boxed boolean/symbol towers), `equal?` (structural
 * recursion delegated to `structuralEqual`, the single representation-blind
 * equality home), and the `procedure?` type predicate. Op bodies are
 * reproduced byte-for-byte — this is a behavior-preserving mechanical
 * extraction. Wired into the env as a capability whose symbols are set raw
 * (`{ value }`), bypassing rosetta wrapping.
 */

import { SchemeBool } from "../SchemeBool.js";
import { SchemeSymbol } from "../SchemeSymbol.js";
import { structuralEqual } from "../structural-equal.js";
import { EnvCapability } from "./capability.js";

export const EQUALITY_OPS = {
  // R7RS 6.3 Booleans
  "boolean=?"(...bools: unknown[]): boolean {
    if (bools.length < 2) return true;
    // L1 boxes `#t` / `#f` as SchemeBool — unwrap before comparing, otherwise
    // `(boolean=? #t #t)` would compare two distinct singletons and pass, but
    // the type-guard one line up would already have rejected the schemeTrue
    // singleton as `typeof !== "boolean"`. Mirror `boolean?`'s post-L1 fix.
    const unwrap = (b: unknown): boolean | undefined => {
      if (typeof b === "boolean") return b;
      if (b instanceof SchemeBool) return b.value;
      return undefined;
    };
    const first = unwrap(bools[0]);
    if (first === undefined) return false;
    return bools.every((b) => unwrap(b) === first);
  },

  // R7RS 6.5 Symbols
  "symbol=?"(...syms: unknown[]): boolean {
    if (syms.length < 2) return true;
    const first = syms[0];
    if (!(first instanceof SchemeSymbol)) return false;
    const firstName = first.__name__;
    return syms.every((s) => s instanceof SchemeSymbol && s.__name__ === firstName);
  },

  "procedure?"(obj: unknown): boolean {
    return typeof obj === "function";
  },

  "equal?"(a: unknown, b: unknown): boolean {
    return structuralEqual(a, b);
  },
};

export default new EnvCapability("scheme/equality", {
  symbols: Object.fromEntries(Object.entries(EQUALITY_OPS).map(([k, v]) => [k, { value: v }])),
});
