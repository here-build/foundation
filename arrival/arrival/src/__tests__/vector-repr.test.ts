// Caveat-sweep finding (2026-06-11): boxed vectors/bytevectors print garbage in
// the repr path (the only user-facing stringify in the MCP bridge env) — and TWO
// divergent garbage strings: "#<vector>" top-level (static __class__) vs
// "#<SchemeVector>" (JS class name) nested in a Pair; bytevector → "#<bytevector>".
// They must render as the R7RS external representation #(...) / #u8(...). repr of
// a vector had ZERO test coverage before this.
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { env, exec } from "../stdlib.js";

await initBridge();
const repr = async (form: string) => String((await exec(form, env) as unknown[])[0]);

describe("vector / bytevector external representation (repr)", () => {
  it("a vector prints #(...) at top level", async () => {
    expect(await repr(`(repr (vector 1 2 3))`)).toBe("#(1 2 3)");
  });
  it("a vector prints #(...) nested in a list (was #<SchemeVector>)", async () => {
    expect(await repr(`(repr (list (vector 1 2)))`)).toBe("(#(1 2))");
  });
  it("a #(...) literal reprs as #(...)", async () => {
    expect(await repr(`(repr #(1 2 3))`)).toBe("#(1 2 3)");
  });
  it("nested vectors recurse", async () => {
    expect(await repr(`(repr (vector 1 (vector 2 3)))`)).toBe("#(1 #(2 3))");
  });
  it("a vector of strings renders elements (repr default = unquoted)", async () => {
    expect(await repr(`(repr (vector "a" "b"))`)).toBe(`#(a b)`);
  });
  it("an empty vector reprs as #()", async () => {
    expect(await repr(`(repr (vector))`)).toBe("#()");
  });
  it("a bytevector prints #u8(...)", async () => {
    expect(await repr(`(repr (bytevector 1 2 255))`)).toBe("#u8(1 2 255)");
  });
});
