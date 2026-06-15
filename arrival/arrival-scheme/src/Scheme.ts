/**
 * Scheme namespace - clean API for Scheme value types
 *
 * This namespace provides the canonical names for Scheme types.
 * Usage: import { Scheme } from 'arrival-scheme'
 *        const s = new Scheme.String("hello")
 *        const n = new Scheme.Exact(42n)
 */

// Re-export classes with clean names
export { SchemeString as String } from "./values/SchemeString.js";
export { SchemeSymbol as Symbol } from "./values/SchemeSymbol.js";
export { SchemeCharacter as Character, Nil as Nil, nil as nil } from "./values/types.js";
export { Pair as Pair } from "./values/Pair.js";
export { SchemeExact as Exact, SchemeInexact as Inexact } from "./values/numbers.js";
export { Environment as Environment } from "./Environment.js";

// Re-export type aliases
export type { SchemeNumeric as Numeric } from "./values/numbers.js";

// Re-export SchemeValue as Value for the generic "any scheme value" type
export type { SchemeValue as Value } from "./values/types.js";
