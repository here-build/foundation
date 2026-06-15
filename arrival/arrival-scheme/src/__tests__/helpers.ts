/**
 * Shared test helpers for arrival-scheme tests
 */

import { SchemeSymbol } from "../values/SchemeSymbol";
import { SchemeExact, SchemeInexact } from "../values/numbers";
import { Pair } from "../values/Pair";
import { nil, type SchemeValue } from "../values/types";

/**
 * Create a Scheme list from JS values
 */
export function list(...items: SchemeValue[]): Pair | typeof nil {
  return Pair.fromArray(items, false) as Pair | typeof nil;
}

/**
 * Create a Scheme symbol
 */
export function sym(name: string): SchemeSymbol {
  return new SchemeSymbol(name);
}

/**
 * Create a Scheme number (exact for integers, inexact for floats)
 */
export function num(n: number | bigint): SchemeExact | SchemeInexact {
  if (typeof n === "bigint") {
    return new SchemeExact(n);
  }
  return Number.isInteger(n) ? new SchemeExact(BigInt(n)) : new SchemeInexact(n);
}

/**
 * Create an exact number (rational)
 */
export function exact(num: number | bigint, denom: number | bigint = 1): SchemeExact {
  return new SchemeExact(BigInt(num), BigInt(denom));
}

/**
 * Create an inexact number (floating point, optionally complex)
 */
export function inexact(real: number, imag: number = 0): SchemeInexact {
  return new SchemeInexact(real, imag);
}
