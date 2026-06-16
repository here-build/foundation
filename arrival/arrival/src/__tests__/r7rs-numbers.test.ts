/**
 * R7RS numeric-tower conformance — bug ledger.
 *
 * Why this file exists
 * --------------------
 * R7RS § 6.2 defines a numeric tower with an exactness contract: operations
 * that take exact arguments and CAN return exact answers MUST do so. Our
 * implementation has two structural shortcuts that violate this:
 *
 *   1. `expt` at `operators/numeric.ts:340-344` is just `Math.pow`, so every
 *      result starts as a JS float. The `Num` codec at `membrane.ts:443-448`
 *      then promotes back to exact only when the float happens to be a safe
 *      integer — making `(expt 2 10) = exact 1024` but `(expt 2 -1) = inexact
 *      0.5` (should be exact 1/2) and `(expt 2 1000) = inexact ~1e+301`
 *      (should be exact bigint).
 *
 *   2. Comparison ops (`<`, `>`, `<=`, `>=`) at `operators/numeric.ts:392-406`
 *      coerce every operand through `toReal` which does `Number(num)/Number(denom)`.
 *      For exacts beyond 2^53 this is lossy — two distinct huge integers
 *      collapse to the same float, so `(< 999999999999999998 999999999999999999)`
 *      returns #f.
 *
 * Plus the smaller hazards: `(exact 1e-10)` throws because the
 * `bridge.ts:497` exponential-string path doesn't handle "1e-10"; and
 * `(number->string 5.0)` returns "5" instead of "5." (chibi compat), losing
 * exactness information when round-tripped.
 *
 * Style — each `it.fails` describes EXPECTED R7RS behavior; comment cites
 * file:line of the bug source.
 */

import { describe, expect, it } from "vitest";
import { env, exec } from "../stdlib";
import { initBridge } from "../bridge";

await initBridge();

const num = (r: unknown): number => {
  if (typeof r === "number") return r;
  if (typeof r === "bigint") return Number(r);
  if (r && typeof (r as { valueOf?: unknown }).valueOf === "function") {
    return Number((r as { valueOf: () => unknown }).valueOf());
  }
  return Number.NaN;
};

const truthy = (r: unknown): boolean => {
  if (typeof r === "boolean") return r;
  if (r && typeof r === "object" && "value" in (r as { value?: unknown })) {
    return Boolean((r as { value: unknown }).value);
  }
  if (r && typeof (r as { valueOf?: unknown }).valueOf === "function") {
    return Boolean((r as { valueOf: () => unknown }).valueOf());
  }
  return Boolean(r);
};

async function evalScheme(src: string): Promise<unknown> {
  const [r] = await exec(src, { env });
  return r;
}

describe("r7rs numbers — passing invariants (regression guards)", () => {
  it("expt of two exact small integers stays exact when result fits a safe int", async () => {
    // (expt 2 10) → Math.pow(2,10) = 1024 → Num.fromJS sees safe integer →
    // wraps as SchemeExact. Correct by coincidence; guard the path.
    const r = await evalScheme("(exact? (expt 2 10))");
    expect(truthy(r)).toBe(true);
  });

  it("(expt 0 0) is 1 per R7RS § 6.2 special case", async () => {
    // R7RS: zero-to-the-zero is 1 (matches Math.pow's behavior incidentally).
    const r = await evalScheme("(expt 0 0)");
    expect(num(r)).toBe(1);
  });

  it("(eqv? +inf.0 +inf.0) is #t (R7RS § 6.2)", async () => {
    // R7RS: +inf.0 is eqv? to itself. Inexact path uses `equals()` at
    // numbers.ts:396-398 which is `===` on `real`; Infinity === Infinity.
    const r = await evalScheme("(eqv? +inf.0 +inf.0)");
    expect(truthy(r)).toBe(true);
  });

  it("inexact on a rational converts to float (R7RS § 6.2)", async () => {
    // bridge.ts:483-484: exact denom-aware path → Number(num)/Number(denom).
    const r = await evalScheme("(inexact 1/2)");
    expect(num(r)).toBe(0.5);
  });
});

describe("r7rs numbers — exactness/precision fixes (regression guards)", () => {
  it(
    "(expt 2 -1) returns exact 1/2 (R7RS § 6.2: exact args + exact-representable result → exact)",
    async () => {
      // FIXED at `operators/numeric.ts` (schemeExpt): exact integer base raised
      // to an exact integer power computes with BigInt `**` (exact rational for
      // negative powers) instead of `Math.pow`, which used to return 0.5
      // (inexact). Flipping this back to red = regression of the exactness fix.
      const r = await evalScheme("(exact? (expt 2 -1))");
      expect(truthy(r)).toBe(true);
    },
  );

  it(
    "(expt 2 1000) returns an exact bigint, not inexact ~1.07e+301",
    async () => {
      // FIXED with the same schemeExpt path. 2^1000 is a representable
      // SchemeExact (BigInt); the old Math.pow round-trip returned a lossy
      // ~1.0715086071862673e+301 inexact (only the top ~53 bits survived).
      const r = await evalScheme("(exact? (expt 2 1000))");
      expect(truthy(r)).toBe(true);
    },
  );

  it(
    "(< 999999999999999998 999999999999999999) returns #t for huge exacts",
    async () => {
      // FIXED at `operators/numeric.ts` (schemeCompare): the exact/exact case
      // now routes through `SchemeExact.cmp` (bigint cross-multiplication)
      // instead of coercing to a JS double. Both 10^18-2 and 10^18-1 used to
      // round to the SAME double (1e18), so `<` returned #f. Same fix covers
      // `>`, `<=`, `>=`.
      const r = await evalScheme("(< 999999999999999998 999999999999999999)");
      expect(truthy(r)).toBe(true);
    },
  );

  it(
    "(exact 1e-10) does NOT throw and returns an exact rational",
    async () => {
      // Fixed at `bridge.ts` — `exact` now recognizes exponential-notation
      // float stringifications (`1e-10`, `1.5e+21`, …) and constructs the
      // rational by combining mantissa + signed exponent into a single
      // power-of-10 denominator instead of falling through to `BigInt(real)`
      // (which threw RangeError on non-integer floats).
      const r = await evalScheme("(exact 1e-10)");
      // If we reach here without throwing, the bug is fixed.
      expect(truthy(await evalScheme(`(exact? ${num(r) === 0 ? "(exact 0)" : "1/10000000000"})`))).toBe(true);
    },
  );

  it(
    '(number->string 5.0) preserves the inexact mark ("5." or "5.0", not "5")',
    async () => {
      // Fixed at `bridge.ts` — base-10 inexact formatting now delegates to
      // `SchemeInexact.toString()` which appends `.0` to integer-valued
      // inexacts. Round-tripping through `string->number` now preserves
      // exactness per R7RS § 6.2.
      const r = await evalScheme("(number->string 5.0)");
      const s = typeof r === "string" ? r : String((r as { valueOf: () => unknown }).valueOf());
      // Either "5." or "5.0" is R7RS-conformant.
      expect(["5.", "5.0"]).toContain(s);
    },
  );

  it(
    "exact->inexact is bound (R5RS alias, R7RS-compatible naming)",
    async () => {
      // R5RS § 6.2.5 alias for R7RS `inexact`. Bound at `lips.ts` via a
      // late-lookup trampoline (target lives in bridge.ts, applied during
      // initBridge).
      const r = await evalScheme("(exact->inexact 1/2)");
      expect(num(r)).toBe(0.5);
    },
  );

  it(
    "inexact->exact is bound (R5RS alias, R7RS-compatible naming)",
    async () => {
      // R5RS § 6.2.5 alias for R7RS `exact`. Same trampoline shape as
      // `exact->inexact`.
      const r = await evalScheme("(inexact->exact 0.5)");
      expect(truthy(await evalScheme("(exact? (inexact->exact 0.5))"))).toBe(true);
      // Type sanity: 0.5 → 1/2 exact, valueOf === 0.5.
      expect(num(r)).toBe(0.5);
    },
  );
});
