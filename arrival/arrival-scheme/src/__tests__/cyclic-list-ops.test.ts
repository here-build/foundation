// Caveat-sweep finding (2026-06-11): list spine-walking builtins spun forever or
// stack-overflowed on a RUNTIME-cyclic list (set-cdr! creates a cycle that the
// metadata-only have_cycles() can't see). Fixed with an active Floyd cycle check
// (Pair.isCircularList) that the ops guard on: a circular list now terminates
// (list? → #f) or raises a clean error instead of spinning.
//
// NOTE: each cyclic case must TERMINATE — a regression reintroduces a sync spin
// that hangs the worker (testTimeout can't interrupt a sync loop). That loud hang
// IS the regression signal.
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { env, exec } from "../stdlib.js";

await initBridge();
const run = async (form: string) => String((await exec(form, env) as unknown[])[0]);
// c = (1 2 3) with its last cdr pointing back at c → a circular list.
const cyclic = (op: string) => `(let ((c (list 1 2 3))) (set-cdr! (cddr c) c) ${op})`;

describe("list ops on a RUNTIME-cyclic list terminate (no spin / stack overflow)", () => {
  it("list? on a circular list → #f", async () => {
    expect(await run(cyclic("(list? c)"))).toBe("false");
  });
  it("length on a circular list raises a clean error", async () => {
    await expect(run(cyclic("(length c)"))).rejects.toThrow(/circular/i);
  });
  it("reverse on a circular list raises a clean error (was 'Invalid array length')", async () => {
    await expect(run(cyclic("(reverse c)"))).rejects.toThrow(/circular/i);
  });
  it("list-copy on a circular list raises a clean error (was 'Maximum call stack')", async () => {
    await expect(run(cyclic("(list-copy c)"))).rejects.toThrow(/circular/i);
  });
  it("memq on a circular list raises a clean error", async () => {
    await expect(run(cyclic("(memq 99 c)"))).rejects.toThrow(/circular/i);
  });
  it("append with a circular non-last arg raises", async () => {
    await expect(run(cyclic("(append c (list 9))"))).rejects.toThrow();
  });
});

describe("acyclic list ops unaffected", () => {
  it("list? proper → #t", async () => expect(await run(`(list? (list 1 2 3))`)).toBe("true"));
  it("list? improper → #f", async () => expect(await run(`(list? (cons 1 2))`)).toBe("false"));
  it("length proper → 3", async () => expect(await run(`(length (list 1 2 3))`)).toBe("3"));
  it("reverse proper", async () => expect(await run(`(reverse (list 1 2 3))`)).toBe("(3 2 1)"));
  it("list-copy proper", async () => expect(await run(`(list-copy (list 1 2 3))`)).toBe("(1 2 3)"));
  it("member proper finds", async () => expect(await run(`(member 2 (list 1 2 3))`)).toBe("(2 3)"));
});
