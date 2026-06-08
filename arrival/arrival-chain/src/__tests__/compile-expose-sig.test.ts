/**
 * `compileExposeSig` (node D4 bridge) — turns the SOURCE SLICES `extractExpose`
 * produces into the CANONICAL TAGGED LISTS the registry stores, by evaluating
 * ONLY the pure `(s/object …)` schema sub-expressions.
 *
 * The contract:
 *   1. an extracted `:input`/`:output` slice lowers to the SAME tagged list the
 *      runtime `onExpose` path produces (so static + runtime registry never
 *      describe different contracts);
 *   2. it is HANDLER-FREE — a declaration whose handler would error/loop is still
 *      compiled (only the schema slices evaluate, never the handler);
 *   3. an absent slice → null; `hasHandler` passes through.
 *
 * Round-trips against `extractExpose` (the real producer of its input) so the two
 * are pinned together — the whole point of the bridge.
 */
import { describe, expect, it } from "vitest";

import { compileExposeSig } from "../compile-expose-sig.js";
import { extractExpose } from "../extract-expose.js";

describe("compileExposeSig — source slices → canonical tagged lists", () => {
  it("compiles :input/:output slices to the SAME tagged lists the runtime path yields", async () => {
    const [info] = await extractExpose(`
      (declare/expose "classify-ticket"
        :input  (s/object (s/field/string "message"))
        :output (s/object (s/field/string "label") (s/field/number "confidence"))
        :handler (lambda (input) (list "label" "bug" "confidence" 0.9)))
    `);
    const sig = await compileExposeSig(info!);
    // Identical shape to the runtime `onExpose` declaration (see
    // extract-expose.test.ts "declare/expose (runtime form)").
    expect(sig.input).toEqual(["object", ["message", "string"]]);
    expect(sig.output).toEqual([
      "object",
      ["label", "string"],
      ["confidence", "number"],
    ]);
    expect(sig.hasHandler).toBe(true);
  });

  it("is handler-free: a declaration whose handler would ERROR still compiles", async () => {
    // If the handler were evaluated, `(error …)` would throw and the compile
    // would fail. It compiles cleanly ⇒ only the schema slices were evaluated.
    const [info] = await extractExpose(`
      (declare/expose "boom"
        :input  (s/object (s/field/string "x"))
        :handler (lambda (input) (error "handler must not run during sig compile")))
    `);
    const sig = await compileExposeSig(info!);
    expect(sig.input).toEqual(["object", ["x", "string"]]);
    expect(sig.hasHandler).toBe(true);
  });

  it("lowers enum + array fields (the non-primitive schema shapes)", async () => {
    const [info] = await extractExpose(`
      (declare/expose "triage"
        :input (s/object
                 (s/field/enum  "bucket" (s/enum "A" "B"))
                 (s/field/array "tags"   (s/array "string")))
        :handler (lambda (input) input))
    `);
    const sig = await compileExposeSig(info!);
    expect(sig.input).toEqual([
      "object",
      ["bucket", ["enum", "A", "B"]],
      ["tags", ["array", "string"]],
    ]);
  });

  it("null slot for an absent schema; hasHandler reflects the static fact", async () => {
    const [withoutOutput] = await extractExpose(`(declare/expose "ping" :handler (lambda (i) "pong"))`);
    const a = await compileExposeSig(withoutOutput!);
    expect(a.input).toBeNull();
    expect(a.output).toBeNull();
    expect(a.hasHandler).toBe(true);

    const [noHandler] = await extractExpose(`(declare/expose "incomplete" :input (s/object (s/field/string "x")))`);
    const b = await compileExposeSig(noHandler!);
    expect(b.input).toEqual(["object", ["x", "string"]]);
    expect(b.hasHandler).toBe(false);
  });
});
