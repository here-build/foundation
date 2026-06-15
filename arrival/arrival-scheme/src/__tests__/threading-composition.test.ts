/**
 * Polyglot threading and composition (env/polyglot.ts).
 *
 * arrival-scheme accepts the whole cross-dialect family so writers (LLMs
 * included) can use whatever muscle-memory they have, exactly like :key
 * accessors:
 *   ->  / ~>    thread the value as the FIRST argument  (Clojure / Racket)
 *   ->> / ~>>   thread the value as the LAST  argument  (Clojure / Racket)
 *   compose / comp   right-to-left function composition
 *   pipe / flow      left-to-right function composition
 *
 * Non-commutative ops ((- …)) prove the first/last insertion direction;
 * compose-vs-pipe is proven by an order-sensitive lambda pair.
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
const val = async (src: string): Promise<unknown> => (await exec(src, { env }))[0];

describe("threading macros — first vs last insertion", () => {
  it("-> inserts the value as the FIRST argument", async () => {
    expect(num(await val(`(-> 10 (- 3))`))).toBe(7); //   (- 10 3)
    expect(num(await val(`(-> 1 (+ 2) (* 10))`))).toBe(30); // (* (+ 1 2) 10)
  });

  it("->> inserts the value as the LAST argument", async () => {
    expect(num(await val(`(->> 10 (- 3))`))).toBe(-7); //  (- 3 10)
    expect(num(await val(`(->> 1 (- 10) (* 2))`))).toBe(18); // (* 2 (- 10 1))
  });

  it("~> and ~>> are Racket-style aliases of -> and ->>", async () => {
    expect(num(await val(`(~> 10 (- 3))`))).toBe(7);
    expect(num(await val(`(~>> 10 (- 3))`))).toBe(-7);
  });

  it("a bare symbol threads as a unary call — the shape :key accessors use", async () => {
    expect(num(await val(`(-> (list 1 2 3) car)`))).toBe(1);
    expect(num(await val(`(->> (list 1 2 3) reverse car)`))).toBe(3);
  });
});

describe("composition combinators — direction + aliases", () => {
  it("compose is right-to-left, pipe is left-to-right", async () => {
    // (+1) then (*2) reading right-to-left for compose, left-to-right for pipe
    expect(num(await val(`((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)`))).toBe(12);
    expect(num(await val(`((pipe (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)`))).toBe(11);
  });

  it("comp aliases compose, flow aliases pipe", async () => {
    expect(num(await val(`((comp car cdr) (list 1 2 3))`))).toBe(2); // car(cdr(xs))
    expect(num(await val(`((flow cdr car) (list 1 2 3))`))).toBe(2); // car(cdr(xs))
  });

  it("the first function may be n-ary", async () => {
    expect(num(await val(`((pipe + (lambda (x) (* x 10))) 2 3)`))).toBe(50); // (* (+ 2 3) 10)
    expect(num(await val(`((compose (lambda (x) (* x 10)) +) 2 3)`))).toBe(50);
  });
});
