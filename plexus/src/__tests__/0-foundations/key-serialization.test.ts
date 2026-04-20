/**
 * Unit tests for key-serialization edge cases
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { deserializeKey, serializeKey } from "../../proxies/key-serialization.js";
import { PathMap } from "../../proxies/PathMap.js";

describe("key-serialization", () => {
  const doc = new Y.Doc();

  describe("special numeric values", () => {
    it("handles Infinity", () => {
      const serialized = serializeKey(Infinity, doc);
      const deserialized = deserializeKey(serialized, doc);
      expect([serialized, deserialized]).to.have.ordered.members(["Value\nInfinity", Infinity]);
    });

    it("handles -Infinity", () => {
      const serialized = serializeKey(-Infinity, doc);
      const deserialized = deserializeKey(serialized, doc);
      expect([serialized, deserialized]).to.have.ordered.members(["Value\n-Infinity", -Infinity]);
    });

    it("handles NaN", () => {
      const serialized = serializeKey(Number.NaN, doc);
      expect(serialized).to.equal("Value\nNaN");

      const deserialized = deserializeKey(serialized, doc);
      expect(Number.isNaN(deserialized)).to.eq(true);
    });
  });

  describe("BigInt values", () => {
    it("handles positive BigInt", () => {
      const serialized = serializeKey(123n, doc);
      const deserialized = deserializeKey(serialized, doc);
      expect([serialized, deserialized]).to.have.ordered.members(["Value\n123n", 123n]);
    });

    it("handles negative BigInt", () => {
      const serialized = serializeKey(-456n, doc);
      const deserialized = deserializeKey(serialized, doc);
      expect([serialized, deserialized]).to.have.ordered.members(["Value\n-456n", -456n]);
    });

    it("handles very large BigInt", () => {
      const large = 12_345_678_901_234_567_890_123_456_789_012_345_678_901_234_567_890n;
      const serialized = serializeKey(large, doc);
      const deserialized = deserializeKey(serialized, doc);
      expect([serialized, deserialized]).to.have.ordered.members([
        "Value\n12345678901234567890123456789012345678901234567890n",
        large,
      ]);
    });
  });

  describe("empty containers", () => {
    it("handles empty Set", () => {
      const serialized = serializeKey(new Set(), doc);
      const deserialized = deserializeKey(serialized, doc);
      expect(serialized).to.equal("Set");
      expect(deserialized).to.be.instanceOf(Set).and.have.property("size", 0);
    });

    it("handles empty Array", () => {
      const serialized = serializeKey([], doc);
      const deserialized = deserializeKey(serialized, doc);
      expect(serialized).to.equal("Array");
      expect(deserialized).to.satisfy((d: unknown) => Array.isArray(d) && (d as unknown[]).length === 0);
    });
  });

  describe("strings with special characters", () => {
    it("handles string with newline characters", () => {
      const key = "hello\nworld\ntest";
      const serialized = serializeKey(key, doc);
      const deserialized = deserializeKey(serialized, doc);
      // JSON.stringify escapes newlines as \n (two chars), not actual newline
      expect([serialized, deserialized]).to.have.ordered.members(['Value\n"hello\\nworld\\ntest"', key]);
    });

    it("handles string with unicode", () => {
      const key = "こんにちは🎉";
      const serialized = serializeKey(key, doc);
      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).to.equal(key);
    });

    it("handles string that looks like BigInt", () => {
      // String "123n" should not be confused with BigInt 123n
      const key = "123n";
      const serialized = serializeKey(key, doc);
      const deserialized = deserializeKey(serialized, doc);
      // Quoted string, not raw 123n - and deserialized is string type
      expect([serialized, deserialized, typeof deserialized]).to.have.ordered.members([
        'Value\n"123n"',
        "123n",
        "string",
      ]);
    });

    it("handles string that looks like Infinity", () => {
      const key = "Infinity";
      const serialized = serializeKey(key, doc);
      const deserialized = deserializeKey(serialized, doc);
      // Quoted string - and deserialized is string type
      expect([serialized, deserialized, typeof deserialized]).to.have.ordered.members([
        'Value\n"Infinity"',
        "Infinity",
        "string",
      ]);
    });
  });

  describe("containers with special values", () => {
    it("handles Set with Infinity and BigInt", () => {
      const set = new Set([Infinity, 42n, -Infinity]);
      const serialized = serializeKey(set, doc);

      // Values should be sorted: -Infinity, Infinity (numbers), then 42n (bigint by string)
      // Actually canonicalSort sorts by type then value...
      const lines = serialized.split("\n");
      expect(lines[0]).to.equal("Set");
      expect(lines).to.include.members(["Infinity", "-Infinity", "42n"]);

      const deserialized = deserializeKey(serialized, doc) as Set<unknown>;
      expect([deserialized.has(Infinity), deserialized.has(-Infinity), deserialized.has(42n)]).to.have.ordered.members([
        true,
        true,
        true,
      ]);
    });

    it("handles Array with mixed special values", () => {
      const arr = [Number.NaN, 123n, "hello\nworld", null];
      const serialized = serializeKey(arr, doc);

      const lines = serialized.split("\n");
      expect(lines).to.have.ordered.members(["Array", "NaN", "123n", String.raw`"hello\nworld"`, "null"]);

      const deserialized = deserializeKey(serialized, doc) as unknown[];
      expect(deserialized).to.satisfy(
        (d: unknown[]) => Number.isNaN(d[0]) && d[1] === 123n && d[2] === "hello\nworld" && d[3] === null,
      );
    });
  });

  describe("validation of disallowed types", () => {
    it("throws on plain object key", () => {
      const plainObject = { foo: "bar" };
      expect(() => serializeKey(plainObject as any, doc)).to.throw(TypeError, /Plain objects are not allowed/);
    });

    it("throws on undefined key", () => {
      expect(() => serializeKey(undefined as any, doc)).to.throw(TypeError, /undefined is not allowed/);
    });

    it("throws on Symbol key", () => {
      const sym = Symbol("test");
      expect(() => serializeKey(sym as any, doc)).to.throw(TypeError, /Symbols are not allowed/);
    });

    it("throws on function key", () => {
      // eslint-disable-next-line unicorn/consistent-function-scoping
      const fn = () => {};
      expect(() => serializeKey(fn as any, doc)).to.throw(TypeError, /Functions are not allowed/);
    });

    it("throws on Set containing plain object", () => {
      const set = new Set([{ nested: true }]);
      expect(() => serializeKey(set as any, doc)).to.throw(TypeError, /Plain objects are not allowed/);
    });

    it("throws on Array containing undefined", () => {
      const arr = [1, undefined, 3];
      expect(() => serializeKey(arr as any, doc)).to.throw(TypeError, /undefined is not allowed/);
    });
  });

  describe("PathMap validation", () => {
    it("throws on plain object key in PathMap", () => {
      const map = new PathMap<any, string>();
      expect(() => map.set({ foo: "bar" }, "value")).to.throw(TypeError, /Plain objects are not allowed/);
    });

    it("throws on Symbol key in PathMap", () => {
      const map = new PathMap<any, string>();
      expect(() => map.set(Symbol("test"), "value")).to.throw(TypeError);
    });

    it("throws on Set containing invalid type in PathMap", () => {
      const map = new PathMap<any, string>();
      expect(() => map.set(new Set([{ bad: true }]), "value")).to.throw(TypeError);
    });

    it("allows valid key types in PathMap", () => {
      const map = new PathMap<any, string>();

      // Primitives
      map.set("string", "v1");
      map.set(123, "v2");
      map.set(true, "v3");
      map.set(null, "v4");
      map.set(456n, "v5");

      // Containers
      map.set(new Set([1, 2, 3]), "v6");
      map.set([1, 2, 3], "v7");

      expect(map).to.have.property("size", 7);
    });
  });
});
