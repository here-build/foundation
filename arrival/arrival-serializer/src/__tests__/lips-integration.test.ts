import { describe, expect, it } from "vitest";
import { toSExprString } from "../serializer";
// Import what we can from lips
import { exec, LBigInteger, lipsToJs, LString, LSymbol, Nil, Pair, sandboxedEnv } from "@here.build/arrival-scheme";
// Import custom matchers
import "@here.build/arrival-scheme";

describe("LIPS Integration", () => {
  it("should handle simple lips evaluation results", async () => {
    // Test basic lips evaluation
    const result = await exec("(+ 1 2)");
    console.log("lips result:", result);
    console.log("lips result type:", typeof result);
    console.log("lips result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("serialized:", serialized);

    // Should get a clean representation, not verbose object dump
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(":__value__"); // Should not expose internals
  });

  it("should handle lips list results", async () => {
    // Test lips list evaluation
    const result = await exec("(list 1 2 3)");
    console.log("lips list result:", result);
    console.log("lips list result type:", typeof result);
    console.log("lips list result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("lips list serialized:", serialized);
    expect(serialized).toBeDefined();
  });

  it("should handle lips symbol results", async () => {
    // Test lips symbol evaluation
    const result = await exec("'hello");
    console.log("lips symbol result:", result);
    console.log("lips symbol result type:", typeof result);
    console.log("lips symbol result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("lips symbol serialized:", serialized);
    expect(serialized).toBeDefined();
  });

  it("should handle complex lips results", async () => {
    // Test more complex lips evaluation
    const result = await exec("(map (lambda (x) (* x 2)) (list 1 2 3))");
    console.log("lips complex result:", result);
    console.log("lips complex result type:", typeof result);
    console.log("lips complex result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("lips complex serialized:", serialized);

    // Should get a clean representation of the mapped results
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(":car"); // Should not expose Pair internals
    expect(serialized).toContain("2"); // 1 * 2
    expect(serialized).toContain("4"); // 2 * 2
    expect(serialized).toContain("6"); // 3 * 2
  });

  it("should handle various lips types", async () => {
    // Test different types that LIPS can return
    const tests = [
      { expr: "42", expected: "42" },
      { expr: "3.14", expected: "3.14" }, // LNumber float
      { expr: "#t", expected: "true" },
      { expr: "#f", expected: "false" },
      { expr: '"hello world"', expected: "'hello world'" }, // Single quotes for simple strings
      { expr: "'symbol-name", expected: "symbol-name" }, // Should be bare symbol
      { expr: "()", expected: "(list nil)" } // edge case - keeping like that for now
    ];

    for (const { expr, expected } of tests) {
      const result = await exec(expr);
      const serialized = toSExprString(result);
      console.log(`${expr} -> ${serialized}`);
      expect(serialized).toContain(expected);
    }
  });

  it("should research keyword vs symbol distinction in LIPS", async () => {
    const tests = [
      { expr: "'hello", desc: "quoted symbol" },
      { expr: ":hello", desc: "colon syntax (keyword?)" },
      { expr: "hello", desc: "bare symbol (probably undefined variable)" },
      { expr: "'hello-world", desc: "quoted symbol with dash" },
      { expr: "':hello", desc: "quoted colon symbol" },
      { expr: "(define hello 42) hello", desc: "defined symbol reference" },
      { expr: "(quote :hello)", desc: "quoted colon syntax" },
      { expr: "123456789012345678901234567890", desc: "very large number (bigint?)" },
      { expr: '"simple string"', desc: "simple string" },
      { expr: '"string with \\"quotes\\""', desc: "string with quotes" }
    ];

    for (const { expr, desc } of tests) {
      try {
        const result = await exec(expr);
        console.log(`\\n=== ${desc} ===`);
        console.log(`Expression: ${expr}`);
        console.log(`Result:`, result);
        console.log(`Constructor:`, result[0]?.constructor?.name);
        console.log(`Properties:`, Object.getOwnPropertyNames(result[0] || {}));
        console.log(`Serialized:`, toSExprString(result));
      } catch (error) {
        console.log(`\\n=== ${desc} ===`);
        console.log(`Expression: ${expr}`);
        console.log(`ERROR:`, error.message);
      }
    }
  });

  it("should handle special lips types", async () => {
    // Test special LIPS types
    const specialTests = [
      { expr: "#\\a", desc: "character" }, // LCharacter
      { expr: "(values 1 2 3)", desc: "multiple values" } // Values
    ];

    for (const { expr, desc } of specialTests) {
      try {
        const result = await exec(expr);
        const serialized = toSExprString(result);
        console.log(`${desc}: ${expr} -> ${serialized}`);
        console.log(`${desc} result type:`, result?.constructor?.name);

        // Debug - can remove this later
        // if (desc === "multiple values") {
        //   console.log("Values debug - keys:", Object.getOwnPropertyNames(result[0]));
        //   console.log("Values debug - has __values__:", "__values__" in result[0]);
        //   console.log("Values debug - has values:", "values" in result[0]);
        //   console.log("Values debug - constructor:", result[0]?.constructor?.name);
        // }

        expect(serialized).toBeDefined();
      } catch (error) {
        console.log(`${desc} failed:`, error);
        // Some might not be supported, that's ok for now
      }
    }
  });
});

describe("exec with proper environment", () => {
  it("should execute single expressions and return unwrapped values", async () => {
    const result = lipsToJs(await exec("(+ 1 2)"), { forceBigInt: true })[0];
    expect(result).toBe(3n); // Native BigInt
  });

  it("should handle multiple expressions (returns first)", async () => {
    const rawResults = await exec("(+ 1 2) (* 3 4) (quote hello)");
    const results = lipsToJs(rawResults, { forceBigInt: true });
    expect(results[0]).toBe(3n); // First result
    expect(results[1]).toBe(12n); // Second result
    // Symbol needs special handling
    expect(rawResults[2]).toBeInstanceOf(LSymbol);
    expect(rawResults[2].__name__).toBe("hello");
  });

  it("should handle lists (returns LIPS Pair)", async () => {
    const result = (await exec("(list 1 2 3)"))[0];
    expect(result).toBeInstanceOf(Pair);
    expect(result.car).toBeInstanceOf(LBigInteger);
  });

  it("should handle symbols (returns LSymbol)", async () => {
    const result = (await exec("'symbol-name"))[0];
    expect(result).toBeInstanceOf(LSymbol);
    expect(result.__name__).toBe("symbol-name");
  });

  it("should handle strings (returns LString)", async () => {
    const result = (await exec('"hello world"'))[0];
    expect(result).toBeInstanceOf(LString);
    expect(result.__string__).toBe("hello world");
  });

  it("should handle booleans", async () => {
    const result = lipsToJs(await exec("#t"))[0];
    expect(result).toBe(true);
  });

  it("should handle complex expressions (returns LIPS structures)", async () => {
    const result = (await exec("(map (lambda (x) (* x 2)) (list 1 2 3))"))[0];
    expect(result).toBeInstanceOf(Pair);
    // Result is Pair with LBigInteger values
    expect(result.car).toBeInstanceOf(LBigInteger);
    expect(result.car.__value__).toBe(2n);
    expect(result.cdr.car.__value__).toBe(4n);
  });

  it("should handle empty expressions (returns Nil)", async () => {
    const result = (await exec("()"))[0];
    expect(result).toBeInstanceOf(Nil);
  });

  it("should have access to Ramda functions", async () => {
    const result = (
      await exec("(map (lambda (x) (+ x 1)) (list 1 2 3))", {
        env: sandboxedEnv
      })
    )[0];
    expect(result).toBeInstanceOf(Pair);

    // Convert to JS values for easier testing
    const values = lipsToJs(result, { forceBigInt: true });
    expect(values).toEqual([2n, 3n, 4n]);
  });

  it("should have access to functional composition", async () => {
    const result = lipsToJs(
      await exec("((compose (lambda (x) (+ x 1)) (lambda (x) (+ x 1))) 5)", {
        env: sandboxedEnv
      }),
      { forceBigInt: true }
    )[0];
    expect(result).toBe(7n);
  });

  it("should support environment variables", async () => {
    const result = lipsToJs(
      await exec("(+ x y)", {
        env: sandboxedEnv.inherit({ x: 10, y: 20 })
      }),
      { forceBigInt: true }
    )[0];
    expect(result).toBe(30n);
  });
});
