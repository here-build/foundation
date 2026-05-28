/**
 * R7RS Unicode conformance — bug ledger.
 *
 * Why this file exists
 * --------------------
 * JavaScript strings are UTF-16 code units; R7RS characters and strings are
 * Unicode code points. The two disagree on every non-BMP character (anything
 * ≥ U+10000 — emoji, ancient scripts, mathematical letters, etc.). Several
 * char/string primitives in `bridge.ts` use UTF-16-grade APIs (`charCodeAt`,
 * `fromCharCode`) where code-point APIs (`codePointAt`, `fromCodePoint`) are
 * required.
 *
 * The other family of bugs is in the `SchemeCharacter.__rev_names__` mapping
 * (`types.ts:149-155`) — for the reverse lookup (codepoint → preferred name),
 * the iteration order over `Object.keys(characters)` decides the winner when
 * two names share a codepoint. `alarm` and `bel` both map to U+0007; the
 * builder iterates "alarm" first then "bel" later, overwriting — so the
 * codepoint resolves to `bel`. R7RS § 6.6 lists `alarm` as the canonical
 * name; `bel` is only the SRFI-175 alias.
 *
 * Style — each `it.fails` describes EXPECTED R7RS behavior with the bug
 * source file:line. `it.fails` = "this should fail today; turning green
 * means the bug is fixed (or it regressed)".
 */

import { describe, expect, it } from "vitest";
import { env, exec } from "../lips";
import { initBridge } from "../bridge";

await initBridge();

/** Coerce a Scheme numeric result to a JS number (handles SchemeExact). */
const num = (r: unknown): number => {
  if (typeof r === "number") return r;
  if (typeof r === "bigint") return Number(r);
  if (r && typeof (r as { valueOf?: unknown }).valueOf === "function") {
    return Number((r as { valueOf: () => unknown }).valueOf());
  }
  return Number.NaN;
};

async function evalScheme(src: string): Promise<unknown> {
  const [r] = await exec(src, { env });
  return r;
}

describe("r7rs unicode — passing invariants (regression guards)", () => {
  it("string-length on emoji returns code-point count, not code-unit count", async () => {
    // `bridge.ts:680` uses `[...str].length` (code-point iteration).
    // "😀" is U+1F600, encoded as two UTF-16 code units but ONE code point.
    const r = await evalScheme(`(string-length "😀")`);
    expect(num(r)).toBe(1);
  });

  it("char->integer on ASCII returns the ASCII codepoint", async () => {
    // Sanity: the bug only surfaces for code points > 0xFFFF. ASCII path
    // works fine via charCodeAt(0).
    const r = await evalScheme("(char->integer #\\A)");
    expect(num(r)).toBe(65);
  });

  it("char-foldcase on a single-folded char (#\\A → #\\a) works", async () => {
    // Only ß-class chars (where Unicode fold expands to 2+ chars) trip the
    // truncation bug. ASCII fold is fine.
    const r = await evalScheme("(char-foldcase #\\A)");
    expect(String(r)).toBe("#\\a");
  });
});

describe("r7rs unicode — known bugs (it.fails — flipping to green = regression of the bug)", () => {
  it(
    "char->integer on a non-BMP character returns the full code point",
    async () => {
      // R7RS § 6.6: `char->integer` returns the Unicode scalar value.
      // `bridge.ts:649` uses `charValue(char).charCodeAt(0)` which returns
      // the FIRST UTF-16 code unit. For U+1F600 (😀), the high surrogate
      // is 0xD83D = 55357, not the actual code point 128512.
      //
      // Predicted failure value: 55357 instead of 128512.
      const r = await evalScheme("(char->integer #\\😀)");
      expect(num(r)).toBe(128512);
    },
  );

  it(
    "integer->char round-trips a non-BMP code point",
    async () => {
      // R7RS § 6.6: `integer->char` is the inverse of `char->integer` over
      // the Unicode code point range. `bridge.ts:655` uses
      // `String.fromCharCode(code)` which silently truncates values > 0xFFFF
      // modulo 0x10000 — 128512 % 65536 = 62976 → "". Round-tripping
      // through char->integer yields 62976 (compounded with the bug above,
      // because char->integer also misreads — but here `` is a single
      // BMP code unit so charCodeAt(0) returns 62976 correctly).
      //
      // Predicted failure value: 62976 instead of 128512.
      const r = await evalScheme("(char->integer (integer->char 128512))");
      expect(num(r)).toBe(128512);
    },
  );

  it(
    "char-foldcase #\\ß returns #\\ß (multi-char folds are identity per R7RS § 6.6)",
    async () => {
      // R7RS § 6.6: char-foldcase takes a character and returns a character.
      // When Unicode fold would expand a single char to multiple chars
      // (Eszett ß → "ss"), R7RS specifies the operation returns the original
      // char unchanged (since a char is by definition a single Unicode
      // scalar value). `bridge.ts:643-645` instead does
      // `folded[0] || charValue(char)` — silently TRUNCATES "ss" to "s",
      // producing a different character from the input.
      //
      // Predicted failure value: #\s instead of #\ß.
      const r = await evalScheme("(char-foldcase #\\ß)");
      expect(String(r)).toBe("#\\ß");
    },
  );

  it(
    "char-alphabetic? recognizes CJK ideographs (Unicode category Lo)",
    async () => {
      // R7RS § 6.6: char-alphabetic? returns #t iff the character is in
      // a Unicode "Letter" category (Lu/Ll/Lt/Lm/Lo). `bridge.ts:600-603`
      // uses `/^[a-z]$/i || lower !== upper` — the second predicate misses
      // CJK (and Hangul, Hebrew, Arabic …) because for category-Lo chars
      // there's no case distinction → toLowerCase() === toUpperCase() →
      // predicate returns #f.
      //
      // Predicted failure value: #f instead of #t.
      const r = await evalScheme("(char-alphabetic? #\\漢)");
      expect(Boolean((r as { valueOf?: () => unknown })?.valueOf?.() ?? r)).toBe(true);
    },
  );

  it.fails(
    "character at code point 7 names as 'alarm' (R7RS-canonical, not 'bel')",
    async () => {
      // R7RS § 6.6 lists `alarm` as the canonical name for U+0007; `bel` is
      // a SRFI-175 alias added later. `types.ts:97-140` registers `alarm`
      // first (line 98) and `bel` later (line 121) — both → "". The
      // `__rev_names__` builder at `types.ts:149-155` iterates
      // `Object.keys(characters)` and OVERWRITES, so the codepoint resolves
      // to whichever name comes last in source order — `bel`.
      //
      // Predicted failure value: "#\bel" instead of "#\alarm".
      const r = await evalScheme("(integer->char 7)");
      expect(String(r)).toBe("#\\alarm");
    },
  );
});
