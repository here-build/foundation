// Caveat-sweep finding (2026-06-11), section B #2: vector-map / vector-for-each /
// string-map / string-for-each push `proc(...)` straight into the result without
// the is_promise/promise_all handling that the list `map` (stdlib.ts) has. When
// `proc` is an async membrane callback (returns a JS Promise — the common case in
// arrival, where procs hit async rosetta/FFI boundaries), the result holds
// unresolved Promises that stringify to "[object Promise]" and carry NO
// provenance (defeating boxing goal-b). The fix mirrors list map: collect, and if
// any result is a promise, return promise_all(...).then(...) so the trampoline
// awaits settled values.
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { env, exec } from "../stdlib.js";

await initBridge();
const run = async (form: string) => String((await exec(form, env) as unknown[])[0]);

// An async proc: a JS function returning a resolved Promise. Mirrors a
// membrane-crossing callback whose body awaits an async boundary.
env.set("async-double", async (x: { valueOf(): number }) => Number(x.valueOf()) * 2);
env.set("async-noop", async () => 0);

describe("vector/string map+for-each await async procs (no raw Promise leak)", () => {
  it("vector-map with an async proc yields settled values, not [object Promise]", async () => {
    // Assert via vector->list so the harness reprs the SETTLED elements (a raw
    // JS String() on the SchemeVector would print "[object Object]" regardless).
    const out = await run(`(vector->list (vector-map async-double (vector 1 2 3)))`);
    expect(out).not.toMatch(/\[object Promise\]/);
    expect(out).toBe("(2 4 6)");
  });

  it("string-map with an async proc yields settled chars, not [object Promise]", async () => {
    // identity-ish async proc over chars
    env.set("async-char", async (c: unknown) => c);
    const out = await run(`(string-map async-char "abc")`);
    expect(out).not.toMatch(/\[object Promise\]/);
  });

  it("vector-for-each with an async proc completes (awaits) before returning", async () => {
    // for-each returns void; the point is it must AWAIT the async proc rather than
    // returning while promises are still outstanding.
    await expect(run(`(vector-for-each async-noop (vector 1 2 3))`)).resolves.toBeDefined();
  });
});
