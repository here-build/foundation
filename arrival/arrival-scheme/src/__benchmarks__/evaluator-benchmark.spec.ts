/**
 * Benchmarks comparing the new generator-based evaluator
 * with the current promise-based LIPS evaluator.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { exec as lipsExec, env as lipsEnv, SchemeSymbol, nil, Pair, parse } from "../lips";
import { initBridge } from "../bridge";
import { exec as genExec } from "../evaluator";
import type { SchemeValue } from "../types";

// Wait for bridge initialization
beforeAll(async () => {
  await initBridge();
});

describe("Evaluator Benchmarks", () => {
  describe("LIPS (promise-based) performance", () => {
    it("benchmark: many simple calls via parse+exec", async () => {
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await lipsExec("(+ 1 2)");
      }

      const elapsed = performance.now() - start;
      console.log(`LIPS evaluator: ${iterations} string parse+exec in ${elapsed.toFixed(2)}ms`);
      console.log(`  ${((iterations / elapsed) * 1000).toFixed(0)} ops/sec`);
    });

    it("benchmark: many simple calls via pre-parsed AST", async () => {
      // Pre-parse the expression once
      const parsed = await parse("(+ 1 2)");
      const ast = parsed[0] as Pair;

      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await lipsExec(ast);
      }

      const elapsed = performance.now() - start;
      console.log(`LIPS evaluator: ${iterations} pre-parsed exec in ${elapsed.toFixed(2)}ms`);
      console.log(`  ${((iterations / elapsed) * 1000).toFixed(0)} ops/sec`);
    });

    it("benchmark: deeply nested expressions", async () => {
      // Build: (+ 1 (+ 1 (+ 1 ... (+ 1 0)...)))
      let code = "(+ 1 0)";
      for (let i = 0; i < 100; i++) {
        code = `(+ 1 ${code})`;
      }

      const iterations = 100;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await lipsExec(code);
      }

      const elapsed = performance.now() - start;
      console.log(`LIPS evaluator: ${iterations} deeply nested (100 levels) in ${elapsed.toFixed(2)}ms`);
      console.log(`  ${((iterations / elapsed) * 1000).toFixed(0)} ops/sec`);
    });
  });

  describe("Generator (flat trampoline) performance", () => {
    function sym(name: string): SchemeSymbol {
      return new SchemeSymbol(name);
    }

    function listLips(...items: SchemeValue[]): Pair | typeof nil {
      if (items.length === 0) return nil;
      let result: Pair | typeof nil = nil;
      for (let i = items.length - 1; i >= 0; i--) {
        result = new Pair(items[i], result);
      }
      return result;
    }

    it("benchmark: many simple calls", async () => {
      // Create AST: (+ 1 2)
      const ast = listLips(sym("+"), 1, 2);

      const iterations = 10000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await genExec(ast, { env: lipsEnv });
      }

      const elapsed = performance.now() - start;
      console.log(`Generator evaluator: ${iterations} simple calls in ${elapsed.toFixed(2)}ms`);
      console.log(`  ${((iterations / elapsed) * 1000).toFixed(0)} ops/sec`);
    });

    it("benchmark: deeply nested expressions", async () => {
      // Build: (+ 1 (+ 1 (+ 1 ... (+ 1 0)...))) with 100 levels
      let ast: SchemeValue = listLips(sym("+"), 1, 0);
      for (let i = 0; i < 100; i++) {
        ast = listLips(sym("+"), 1, ast);
      }

      const iterations = 100;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await genExec(ast, { env: lipsEnv });
      }

      const elapsed = performance.now() - start;
      console.log(`Generator evaluator: ${iterations} deeply nested (100 levels) in ${elapsed.toFixed(2)}ms`);
      console.log(`  ${((iterations / elapsed) * 1000).toFixed(0)} ops/sec`);
    });

    it("benchmark: stack depth limit test (10000 levels)", async () => {
      // Build 10000 levels of nesting
      let ast: SchemeValue = listLips(sym("+"), 1, 0);
      for (let i = 0; i < 10000; i++) {
        ast = listLips(sym("+"), 1, ast);
      }

      const start = performance.now();
      const result = await genExec(ast, { env: lipsEnv });
      const elapsed = performance.now() - start;

      console.log(`Generator evaluator: 10000 level nesting in ${elapsed.toFixed(2)}ms`);
      // LIPS returns SchemeExact objects, so use valueOf()
      const value = (result as { valueOf?: () => unknown })?.valueOf?.() ?? result;
      expect(value).toBe(10001);
    });
  });

  describe("Side-by-side comparison", () => {
    it("compare: simple arithmetic", async () => {
      // Parse once for LIPS
      const parsed = await parse("(+ 1 2 3 4 5)");
      const lipsAst = parsed[0] as Pair;

      // Create equivalent AST for generator
      const genAst = new Pair(
        new SchemeSymbol("+"),
        new Pair(1, new Pair(2, new Pair(3, new Pair(4, new Pair(5, nil))))),
      );

      const iterations = 1000;

      // LIPS
      const lipsStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await lipsExec(lipsAst);
      }
      const lipsElapsed = performance.now() - lipsStart;

      // Generator
      const genStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await genExec(genAst, { env: lipsEnv });
      }
      const genElapsed = performance.now() - genStart;

      const speedup = lipsElapsed / genElapsed;

      console.log(`\n=== Simple arithmetic (+ 1 2 3 4 5) x${iterations} ===`);
      console.log(`LIPS:      ${lipsElapsed.toFixed(2)}ms (${((iterations / lipsElapsed) * 1000).toFixed(0)} ops/sec)`);
      console.log(`Generator: ${genElapsed.toFixed(2)}ms (${((iterations / genElapsed) * 1000).toFixed(0)} ops/sec)`);
      console.log(`Speedup:   ${speedup.toFixed(2)}x`);

      // Verify correctness (LIPS returns SchemeExact, so use valueOf)
      const lipsResult = await lipsExec(lipsAst);
      const genResult = await genExec(genAst, { env: lipsEnv });
      expect((lipsResult[0] as { valueOf?: () => unknown })?.valueOf?.() ?? lipsResult[0]).toBe(15);
      expect((genResult as { valueOf?: () => unknown })?.valueOf?.() ?? genResult).toBe(15);
    });

    it("compare: nested function calls", async () => {
      // (+ (* 2 3) (* 4 5))
      const parsed = await parse("(+ (* 2 3) (* 4 5))");
      const lipsAst = parsed[0] as Pair;

      // Create equivalent AST for generator
      const genAst = new Pair(
        new SchemeSymbol("+"),
        new Pair(
          new Pair(new SchemeSymbol("*"), new Pair(2, new Pair(3, nil))),
          new Pair(new Pair(new SchemeSymbol("*"), new Pair(4, new Pair(5, nil))), nil),
        ),
      );

      const iterations = 1000;

      // LIPS
      const lipsStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await lipsExec(lipsAst);
      }
      const lipsElapsed = performance.now() - lipsStart;

      // Generator
      const genStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await genExec(genAst, { env: lipsEnv });
      }
      const genElapsed = performance.now() - genStart;

      const speedup = lipsElapsed / genElapsed;

      console.log(`\n=== Nested calls (+ (* 2 3) (* 4 5)) x${iterations} ===`);
      console.log(`LIPS:      ${lipsElapsed.toFixed(2)}ms (${((iterations / lipsElapsed) * 1000).toFixed(0)} ops/sec)`);
      console.log(`Generator: ${genElapsed.toFixed(2)}ms (${((iterations / genElapsed) * 1000).toFixed(0)} ops/sec)`);
      console.log(`Speedup:   ${speedup.toFixed(2)}x`);

      // Verify correctness (LIPS returns SchemeExact, so use valueOf)
      const lipsResult = await lipsExec(lipsAst);
      const genResult = await genExec(genAst, { env: lipsEnv });
      expect((lipsResult[0] as { valueOf?: () => unknown })?.valueOf?.() ?? lipsResult[0]).toBe(26);
      expect((genResult as { valueOf?: () => unknown })?.valueOf?.() ?? genResult).toBe(26);
    });
  });
});
