/**
 * String ops — the R7RS § 6.7 string cluster, carved VERBATIM out of
 * `wrappedOps` in `../bridge.ts`. These are behavior-preserving copies of the
 * interpreter's string constructors, accessors, comparisons (case-sensitive and
 * case-insensitive), append, list conversions, copy/slice, case conversion, and
 * the higher-order `string-map` / `string-for-each`. The only change from the
 * bridge originals is that cross-cutting helpers (`assertAllocatable`,
 * `charValue`, `coerceNumeric`, `deriveOrd`, `stringValue`, `toIndex`,
 * `withInputProvenance`, and the provenance collapse pair `collapseProvenance` /
 * `taintString`) are imported rather than referenced as bridge locals. The
 * implementations — including inline comments — are otherwise identical to the
 * source. (`number->string` deliberately stays in the bridge.)
 */

import foldCase from "fold-case";
import invariant from "tiny-invariant";

import {
  assertAllocatable,
  charValue,
  coerceNumeric,
  deriveOrd,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../op-helpers.js";
import { collapseProvenance, taintString } from "../provenance-collapse.js";
import { SchemeString } from "../SchemeString.js";
import { SchemeExact } from "../numbers.js";
import { Pair } from "../Pair.js";
import { SchemeCharacter, nil } from "../types.js";
import { is_promise } from "../guards.js";
import { promise_all } from "../utils/promises.js";
import { EnvCapability } from "./capability.js";

export const STRING_OPS = {
  "make-string"(k: unknown, char?: unknown): SchemeString {
    const len = Number(coerceNumeric(k).valueOf());
    // O(1) cap check BEFORE `.repeat(len)` allocates — see assertAllocatable.
    assertAllocatable(len, "make-string");
    const c = char ? charValue(char) : "\u0000";
    // Both the length and (when present) the filling char contribute lineage —
    // `(make-string n user-char)` should remember user-char as a source even
    // though the length is what dictates the result's size.
    return withInputProvenance(
      char === undefined ? [k] : [k, char],
      new SchemeString(c.repeat(len)),
    );
  },

  string(...chars: unknown[]): SchemeString {
    // Union of every character argument — same shape as `vector` below.
    return withInputProvenance(chars, new SchemeString(chars.map(charValue).join("")));
  },

  "string-length"(str: unknown): SchemeExact {
    return new SchemeExact(BigInt([...stringValue(str)].length));
  },

  "string-ref"(str: unknown, k: unknown): SchemeCharacter {
    const idx = Number(coerceNumeric(k).valueOf());
    return new SchemeCharacter([...stringValue(str)][idx]);
  },

  // string-set! / string-fill! — OMITTED by the purity invariant (frozen
  // entities); doored in bootstrap.ts. See plan-2026-06-11-purity-pass.

  // String comparison
  "string=?"(...strs: unknown[]): boolean {
    if (strs.length < 2) return true;
    const first = stringValue(strs[0]);
    return strs.slice(1).every((s) => stringValue(s) === first);
  },

  // string</>/<=/>= derive from SchemeString's fantasy-land/lte (wave-1 Ord) via
  // the shared deriveOrd chain — same adapter as the char family.
  "string<?": deriveOrd("<"),
  "string>?": deriveOrd(">"),
  "string<=?": deriveOrd("<="),
  "string>=?": deriveOrd(">="),

  // Case-insensitive string comparison
  "string-ci=?"(...strs: unknown[]): boolean {
    if (strs.length < 2) return true;
    const first = stringValue(strs[0]).toLowerCase();
    return strs.slice(1).every((s) => stringValue(s).toLowerCase() === first);
  },

  "string-ci<?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() >= stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-ci>?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() <= stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-ci<=?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() > stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-ci>=?"(...strs: unknown[]): boolean {
    for (let i = 0; i < strs.length - 1; i++) {
      if (stringValue(strs[i]).toLowerCase() < stringValue(strs[i + 1]).toLowerCase()) return false;
    }
    return true;
  },

  "string-append"(...strs: unknown[]): string | SchemeString {
    // Collapsing op: the result inherits lineage from every input — and DEEP, so a
    // nested structure (a list/vector/array of inference-stamped values) is hoisted,
    // not just the top-level AValue args. Without this, `(string-append prefix
    // (join "" parts))` forgets where `parts` came from. See provenance-collapse.ts.
    return taintString(strs.map(stringValue).join(""), collapseProvenance(...strs));
  },

  "string->list"(str: unknown, start?: unknown, end?: unknown): unknown {
    const chars = [...stringValue(str)];
    const startIdx = start === undefined ? 0 : toIndex(start);
    const endIdx = end === undefined ? chars.length : toIndex(end);
    let result: unknown = nil;
    for (let i = endIdx - 1; i >= startIdx; i--) result = new Pair(new SchemeCharacter(chars[i]), result);
    return result;
  },

  "list->string"(list: unknown): SchemeString {
    const chars: string[] = [];
    let current = list;
    while (current && current !== nil && current instanceof Pair) {
      chars.push(charValue(current.car));
      current = current.cdr;
    }
    return new SchemeString(chars.join(""));
  },

  "string-copy"(str: unknown, start?: unknown, end?: unknown): SchemeString {
    const chars = [...stringValue(str)];
    const startIdx = start === undefined ? 0 : toIndex(start);
    const endIdx = end === undefined ? chars.length : toIndex(end);
    // The copy is a fresh allocation but semantically the same lineage as `str`
    // (start/end indices don't carry meaning here, they shape the slice).
    return withInputProvenance([str], new SchemeString(chars.slice(startIdx, endIdx).join("")));
  },

  // string-copy! — OMITTED by the purity invariant (mutates its destination);
  // doored in bootstrap.ts. The non-mutating `string-copy` stays.

  // Case conversion for strings — case is a presentation transform, not a
  // new origin; inherit the source's lineage so downstream `define` of the
  // result still traces to the original infer/query call.
  "string-upcase"(str: unknown): SchemeString {
    return withInputProvenance([str], new SchemeString(stringValue(str).toUpperCase()));
  },

  "string-downcase"(str: unknown): SchemeString {
    return withInputProvenance([str], new SchemeString(stringValue(str).toLowerCase()));
  },

  "string-foldcase"(str: unknown): SchemeString {
    return withInputProvenance([str], new SchemeString(foldCase(stringValue(str))));
  },

  "string-map"(proc: Function, ...strings: unknown[]): string | Promise<string> {
    invariant(strings.length > 0, "string-map: expected at least one string");
    const strs = strings.map(stringValue);
    const minLen = Math.min(...strs.map((s) => s.length));
    const results: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      results.push(proc(...strs.map((s) => new SchemeCharacter(s[i]))));
    }
    const join = (chars: unknown[]) =>
      chars
        .map((c) => (c instanceof SchemeCharacter ? charValue(c) : typeof c === "string" ? c : String(c)))
        .join("");
    // proc may be an async membrane callback → await before joining, so the result
    // is a real string, not "[object Promise][object Promise]…" (see vector-map).
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<unknown[]>).then(join);
    }
    return join(results);
  },

  "string-for-each"(proc: Function, ...strings: unknown[]): void | Promise<void> {
    invariant(strings.length > 0, "string-for-each: expected at least one string");
    const strs = strings.map(stringValue);
    const minLen = Math.min(...strs.map((s) => s.length));
    const pending: unknown[] = [];
    for (let i = 0; i < minLen; i++) {
      const ret = proc(...strs.map((s) => new SchemeCharacter(s[i])));
      if (is_promise(ret)) pending.push(ret);
    }
    if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => undefined);
  },
};

export default new EnvCapability("scheme/strings", {
  symbols: Object.fromEntries(Object.entries(STRING_OPS).map(([k, v]) => [k, { value: v }])),
});
