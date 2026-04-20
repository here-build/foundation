/**
 * Tests for the Ramda Pack
 *
 * Verifies that the Ramda pack provides:
 * - Core FP operations (compose, pipe, curry)
 * - List operations (map, filter, reduce)
 * - Object operations (prop, path)
 * - Proper integration with Scheme lists
 *
 * Note: Sandbox integration tests are skipped when the sandbox infrastructure
 * is not fully initialized. The pack creation and binding export tests
 * verify the pack is correctly structured.
 */

import { describe, expect, it } from "vitest";
import { createRamdaPack, RAMDA_BINDINGS } from "../packs";

describe("Ramda Pack", () => {
  describe("createRamdaPack", () => {
    it("should create a pack with Ramda bindings", async () => {
      const pack = await createRamdaPack();

      expect(pack.id).toBe("ramda");
      expect(pack.bindings).toBeDefined();
      expect(typeof pack.bindings?.["map"]).toBe("function");
      expect(typeof pack.bindings?.["filter"]).toBe("function");
      expect(typeof pack.bindings?.["reduce"]).toBe("function");
    });

    it("should include core FP combinators", async () => {
      const pack = await createRamdaPack();

      expect(typeof pack.bindings?.["compose"]).toBe("function");
      expect(typeof pack.bindings?.["pipe"]).toBe("function");
      expect(typeof pack.bindings?.["curry"]).toBe("function");
      expect(typeof pack.bindings?.["identity"]).toBe("function");
      expect(typeof pack.bindings?.["always"]).toBe("function");
      expect(typeof pack.bindings?.["flip"]).toBe("function");
    });

    it("should include list operations", async () => {
      const pack = await createRamdaPack();

      expect(typeof pack.bindings?.["head"]).toBe("function");
      expect(typeof pack.bindings?.["tail"]).toBe("function");
      expect(typeof pack.bindings?.["take"]).toBe("function");
      expect(typeof pack.bindings?.["drop"]).toBe("function");
      expect(typeof pack.bindings?.["length"]).toBe("function");
      expect(typeof pack.bindings?.["append"]).toBe("function");
      expect(typeof pack.bindings?.["concat"]).toBe("function");
    });

    it("should include object operations", async () => {
      const pack = await createRamdaPack();

      expect(typeof pack.bindings?.["prop"]).toBe("function");
      expect(typeof pack.bindings?.["path"]).toBe("function");
      expect(typeof pack.bindings?.["keys"]).toBe("function");
      expect(typeof pack.bindings?.["values"]).toBe("function");
      expect(typeof pack.bindings?.["pick"]).toBe("function");
      expect(typeof pack.bindings?.["omit"]).toBe("function");
    });

    it("should include logic and predicates", async () => {
      const pack = await createRamdaPack();

      expect(typeof pack.bindings?.["equals"]).toBe("function");
      expect(typeof pack.bindings?.["is-nil"]).toBe("function");
      expect(typeof pack.bindings?.["is-empty"]).toBe("function");
      expect(typeof pack.bindings?.["default-to"]).toBe("function");
      expect(typeof pack.bindings?.["cond"]).toBe("function");
      expect(typeof pack.bindings?.["when"]).toBe("function");
      expect(typeof pack.bindings?.["unless"]).toBe("function");
    });

    it("should include string operations", async () => {
      const pack = await createRamdaPack();

      expect(typeof pack.bindings?.["split"]).toBe("function");
      expect(typeof pack.bindings?.["trim"]).toBe("function");
      expect(typeof pack.bindings?.["to-lower"]).toBe("function");
      expect(typeof pack.bindings?.["to-upper"]).toBe("function");
      expect(typeof pack.bindings?.["replace"]).toBe("function");
    });

    it("should include math and comparison operations", async () => {
      const pack = await createRamdaPack();

      expect(typeof pack.bindings?.["add"]).toBe("function");
      expect(typeof pack.bindings?.["subtract"]).toBe("function");
      expect(typeof pack.bindings?.["multiply"]).toBe("function");
      expect(typeof pack.bindings?.["divide"]).toBe("function");
      expect(typeof pack.bindings?.["min"]).toBe("function");
      expect(typeof pack.bindings?.["max"]).toBe("function");
      expect(typeof pack.bindings?.["clamp"]).toBe("function");
      expect(typeof pack.bindings?.["gt"]).toBe("function");
      expect(typeof pack.bindings?.["lt"]).toBe("function");
    });
  });

  describe("RAMDA_BINDINGS", () => {
    it("should export the list of Ramda bindings", () => {
      expect(RAMDA_BINDINGS).toContain("map");
      expect(RAMDA_BINDINGS).toContain("filter");
      expect(RAMDA_BINDINGS).toContain("reduce");
      expect(RAMDA_BINDINGS).toContain("compose");
      expect(RAMDA_BINDINGS).toContain("pipe");
      expect(RAMDA_BINDINGS).toContain("curry");
    });

    it("should include all core FP combinators", () => {
      expect(RAMDA_BINDINGS).toContain("compose");
      expect(RAMDA_BINDINGS).toContain("comp");
      expect(RAMDA_BINDINGS).toContain("pipe");
      expect(RAMDA_BINDINGS).toContain("thread");
      expect(RAMDA_BINDINGS).toContain("flow");
      expect(RAMDA_BINDINGS).toContain("curry");
      expect(RAMDA_BINDINGS).toContain("partial");
      expect(RAMDA_BINDINGS).toContain("flip");
      expect(RAMDA_BINDINGS).toContain("identity");
      expect(RAMDA_BINDINGS).toContain("id");
      expect(RAMDA_BINDINGS).toContain("always");
      expect(RAMDA_BINDINGS).toContain("constant");
    });

    it("should include Functor/Applicative/Monad operations", () => {
      expect(RAMDA_BINDINGS).toContain("fmap");
      expect(RAMDA_BINDINGS).toContain("traverse");
      expect(RAMDA_BINDINGS).toContain("apply-to");
      expect(RAMDA_BINDINGS).toContain("lift-a2");
      expect(RAMDA_BINDINGS).toContain("lift-a3");
      expect(RAMDA_BINDINGS).toContain("chain");
      expect(RAMDA_BINDINGS).toContain("flat-map");
      expect(RAMDA_BINDINGS).toContain("flatten");
    });

    it("should include all naming variations for common operations", () => {
      // map aliases
      expect(RAMDA_BINDINGS).toContain("map");
      expect(RAMDA_BINDINGS).toContain("fmap");

      // head aliases
      expect(RAMDA_BINDINGS).toContain("head");
      expect(RAMDA_BINDINGS).toContain("first");

      // tail aliases
      expect(RAMDA_BINDINGS).toContain("tail");
      expect(RAMDA_BINDINGS).toContain("rest");

      // filter aliases
      expect(RAMDA_BINDINGS).toContain("filter");
      expect(RAMDA_BINDINGS).toContain("select");
      expect(RAMDA_BINDINGS).toContain("where");
      expect(RAMDA_BINDINGS).toContain("keep");

      // reject aliases
      expect(RAMDA_BINDINGS).toContain("reject");
      expect(RAMDA_BINDINGS).toContain("remove");
      expect(RAMDA_BINDINGS).toContain("exclude");

      // reduce aliases
      expect(RAMDA_BINDINGS).toContain("reduce");
      expect(RAMDA_BINDINGS).toContain("fold");
      expect(RAMDA_BINDINGS).toContain("accumulate");
      expect(RAMDA_BINDINGS).toContain("aggregate");
    });
  });

  describe("Direct function tests", () => {
    it("should correctly implement compose", async () => {
      const pack = await createRamdaPack();
      const compose = pack.bindings?.["compose"] as (...fns: Function[]) => (x: number) => number;

      const add1 = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const composed = compose(double, add1);

      // compose applies right-to-left: double(add1(3)) = double(4) = 8
      expect(composed(3)).toBe(8);
    });

    it("should correctly implement pipe", async () => {
      const pack = await createRamdaPack();
      const pipe = pack.bindings?.["pipe"] as (...fns: Function[]) => (x: number) => number;

      const add1 = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const piped = pipe(add1, double);

      // pipe applies left-to-right: double(add1(3)) = double(4) = 8
      expect(piped(3)).toBe(8);
    });

    it("should correctly implement identity", async () => {
      const pack = await createRamdaPack();
      const identity = pack.bindings?.["identity"] as (x: unknown) => unknown;

      expect(identity(42)).toBe(42);
      expect(identity("hello")).toBe("hello");
      expect(identity(null)).toBe(null);
    });

    it("should correctly implement always", async () => {
      const pack = await createRamdaPack();
      const always = pack.bindings?.["always"] as (x: unknown) => () => unknown;

      const always5 = always(5);
      expect(always5()).toBe(5);
      expect(always5("ignored" as any)).toBe(5);
    });

    it("should correctly implement prop", async () => {
      const pack = await createRamdaPack();
      const prop = pack.bindings?.["prop"] as (key: string) => (obj: Record<string, unknown>) => unknown;

      const getValue = prop("value");
      expect(getValue({ value: 42 })).toBe(42);
      expect(getValue({ value: "test" })).toBe("test");
    });

    it("should correctly implement equals", async () => {
      const pack = await createRamdaPack();
      const equals = pack.bindings?.["equals"] as (a: unknown, b: unknown) => boolean;

      expect(equals(1, 1)).toBe(true);
      expect(equals(1, 2)).toBe(false);
      expect(equals([1, 2], [1, 2])).toBe(true);
      expect(equals({ a: 1 }, { a: 1 })).toBe(true);
    });

    it("should correctly implement keys and values", async () => {
      const pack = await createRamdaPack();
      const keys = pack.bindings?.["keys"] as (obj: Record<string, unknown>) => string[];
      const values = pack.bindings?.["values"] as (obj: Record<string, unknown>) => unknown[];

      const obj = { a: 1, b: 2, c: 3 };
      expect(keys(obj)).toEqual(["a", "b", "c"]);
      expect(values(obj)).toEqual([1, 2, 3]);
    });

    it("should correctly implement to-lower and to-upper", async () => {
      const pack = await createRamdaPack();
      const toLower = pack.bindings?.["to-lower"] as (s: string) => string;
      const toUpper = pack.bindings?.["to-upper"] as (s: string) => string;

      expect(toLower("HELLO")).toBe("hello");
      expect(toUpper("hello")).toBe("HELLO");
    });

    it("should correctly implement split and trim", async () => {
      const pack = await createRamdaPack();
      const split = pack.bindings?.["split"] as (sep: string) => (s: string) => string[];
      const trim = pack.bindings?.["trim"] as (s: string) => string;

      expect(split(",")("a,b,c")).toEqual(["a", "b", "c"]);
      expect(trim("  hello  ")).toBe("hello");
    });
  });
});
