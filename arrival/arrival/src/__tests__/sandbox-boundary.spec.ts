import { describe, it, expect } from "vitest";
import {
  SANDBOX_BOUNDARY,
  SandboxViolationError,
  sandboxedAccess,
  sandboxedHas,
  sandboxedKeys,
  sandboxedSet,
  sandboxedDelete,
  NOT_FOUND,
  markAsSandboxBoundary,
  isSandboxBoundary,
} from "../sandbox-boundary";

describe("Sandbox Boundary", () => {
  describe("sandboxedAccess", () => {
    it("returns own properties", () => {
      const obj = { name: "Alice", age: 30 };
      expect(sandboxedAccess(obj, "name")).toBe("Alice");
      expect(sandboxedAccess(obj, "age")).toBe(30);
    });

    it("returns NOT_FOUND for missing properties", () => {
      const obj = { name: "Alice" };
      expect(sandboxedAccess(obj, "missing")).toBe(NOT_FOUND);
    });

    it("returns NOT_FOUND for null/undefined", () => {
      expect(sandboxedAccess(null, "key")).toBe(NOT_FOUND);
      expect(sandboxedAccess(undefined, "key")).toBe(NOT_FOUND);
    });

    it("throws SandboxViolationError for blocked property names", () => {
      const obj = { name: "Alice" };
      expect(() => sandboxedAccess(obj, "constructor")).toThrow(SandboxViolationError);
      expect(() => sandboxedAccess(obj, "__proto__")).toThrow(SandboxViolationError);
      expect(() => sandboxedAccess(obj, "prototype")).toThrow(SandboxViolationError);
    });

    it("throws for inherited properties from Object.prototype", () => {
      const obj = { name: "Alice" };
      expect(() => sandboxedAccess(obj, "toString")).toThrow(SandboxViolationError);
      expect(() => sandboxedAccess(obj, "hasOwnProperty")).toThrow(SandboxViolationError);
      expect(() => sandboxedAccess(obj, "valueOf")).toThrow(SandboxViolationError);
    });

    it("allows inherited properties from non-boundary prototypes", () => {
      class MyClass {
        inheritedMethod() {
          return "inherited";
        }
      }
      const instance = new MyClass();
      (instance as { ownProp?: string }).ownProp = "own";

      expect(sandboxedAccess(instance, "ownProp")).toBe("own");
      expect(sandboxedAccess(instance, "inheritedMethod")).toBeInstanceOf(Function);
    });

    it("blocks when custom class is marked as boundary", () => {
      class SecureAPI {
        static [SANDBOX_BOUNDARY] = true;
        secretMethod() {
          return "secret";
        }
      }

      class UserClass extends SecureAPI {
        publicMethod() {
          return "public";
        }
      }

      const instance = new UserClass();
      (instance as { ownProp?: string }).ownProp = "own";

      // Own property - accessible
      expect(sandboxedAccess(instance, "ownProp")).toBe("own");

      // Inherited from UserClass (not a boundary) - accessible
      expect(sandboxedAccess(instance, "publicMethod")).toBeInstanceOf(Function);

      // Inherited from SecureAPI (boundary) - blocked
      expect(() => sandboxedAccess(instance, "secretMethod")).toThrow(SandboxViolationError);
    });
  });

  describe("sandboxedHas", () => {
    it("returns true for own properties", () => {
      const obj = { name: "Alice" };
      expect(sandboxedHas(obj, "name")).toBe(true);
    });

    it("returns false for missing properties", () => {
      const obj = { name: "Alice" };
      expect(sandboxedHas(obj, "missing")).toBe(false);
    });

    it("returns false for blocked properties (doesn't throw)", () => {
      const obj = { name: "Alice" };
      expect(sandboxedHas(obj, "constructor")).toBe(false);
      expect(sandboxedHas(obj, "__proto__")).toBe(false);
    });

    it("returns false for Object.prototype inherited properties", () => {
      const obj = { name: "Alice" };
      expect(sandboxedHas(obj, "toString")).toBe(false);
      expect(sandboxedHas(obj, "hasOwnProperty")).toBe(false);
    });

    it("returns true for non-boundary inherited properties", () => {
      class MyClass {
        method() {}
      }
      const instance = new MyClass();
      expect(sandboxedHas(instance, "method")).toBe(true);
    });
  });

  describe("sandboxedKeys", () => {
    it("returns own enumerable keys", () => {
      const obj = { a: 1, b: 2, c: 3 };
      expect(sandboxedKeys(obj)).toEqual(["a", "b", "c"]);
    });

    it("never includes inherited keys", () => {
      class MyClass {
        method() {}
      }
      const instance = new MyClass();
      (instance as { own?: string }).own = "value";

      const keys = sandboxedKeys(instance);
      expect(keys).toEqual(["own"]);
      expect(keys).not.toContain("method");
      expect(keys).not.toContain("toString");
    });

    it("returns empty array for null/undefined", () => {
      expect(sandboxedKeys(null)).toEqual([]);
      expect(sandboxedKeys(undefined)).toEqual([]);
    });
  });

  describe("sandboxedSet", () => {
    it("sets own properties", () => {
      const obj: any = {};
      sandboxedSet(obj, "name", "Alice");
      expect(obj.name).toBe("Alice");
    });

    it("shadows inherited properties by creating own property", () => {
      const obj: any = {};
      sandboxedSet(obj, "toString", "my toString");
      expect(obj.toString).toBe("my toString");
      expect(Object.hasOwn(obj, "toString")).toBe(true);
    });

    it("throws for blocked property names", () => {
      const obj: any = {};
      expect(() => sandboxedSet(obj, "constructor", "value")).toThrow(SandboxViolationError);
      expect(() => sandboxedSet(obj, "__proto__", "value")).toThrow(SandboxViolationError);
    });

    it("throws for null/undefined", () => {
      expect(() => sandboxedSet(null, "key", "value")).toThrow(TypeError);
      expect(() => sandboxedSet(undefined, "key", "value")).toThrow(TypeError);
    });
  });

  describe("sandboxedDelete", () => {
    it("deletes own properties", () => {
      const obj: any = { name: "Alice" };
      expect(sandboxedDelete(obj, "name")).toBe(true);
      expect("name" in obj).toBe(false);
    });

    it("returns false for missing properties", () => {
      const obj: any = { name: "Alice" };
      expect(sandboxedDelete(obj, "missing")).toBe(false);
    });

    it("returns false for inherited properties (no-op)", () => {
      const obj: any = { name: "Alice" };
      expect(sandboxedDelete(obj, "toString")).toBe(false);
      // toString still works via prototype
      expect(obj.toString).toBeInstanceOf(Function);
    });

    it("returns false for blocked properties", () => {
      const obj: any = { name: "Alice" };
      expect(sandboxedDelete(obj, "constructor")).toBe(false);
    });
  });

  describe("markAsSandboxBoundary", () => {
    it("marks a class as a boundary", () => {
      class TestClass {}
      markAsSandboxBoundary(TestClass);
      expect(isSandboxBoundary(TestClass.prototype)).toBe(true);
    });

    it("marks an object as a boundary", () => {
      const obj = {};
      markAsSandboxBoundary(obj);
      expect((obj as Record<symbol, unknown>)[SANDBOX_BOUNDARY]).toBe(true);
    });
  });

  describe("isSandboxBoundary", () => {
    it("returns true for Object.prototype", () => {
      expect(isSandboxBoundary(Object.prototype)).toBe(true);
    });

    it("returns true for Array.prototype", () => {
      expect(isSandboxBoundary(Array.prototype)).toBe(true);
    });

    it("returns true for Function.prototype", () => {
      expect(isSandboxBoundary(Function.prototype)).toBe(true);
    });

    it("returns true for null", () => {
      expect(isSandboxBoundary(null)).toBe(true);
    });

    it("returns false for custom class prototype", () => {
      class MyClass {}
      expect(isSandboxBoundary(MyClass.prototype)).toBe(false);
    });

    it("returns true for marked class prototype", () => {
      class SecureClass {
        static [SANDBOX_BOUNDARY] = true;
      }
      expect(isSandboxBoundary(SecureClass.prototype)).toBe(true);
    });
  });

  describe("Array access", () => {
    it("allows index access on arrays", () => {
      const arr = ["a", "b", "c"];
      expect(sandboxedAccess(arr, "0")).toBe("a");
      expect(sandboxedAccess(arr, "1")).toBe("b");
      expect(sandboxedAccess(arr, "length")).toBe(3);
    });

    it("blocks Array.prototype methods", () => {
      const arr = ["a", "b", "c"];
      expect(() => sandboxedAccess(arr, "push")).toThrow(SandboxViolationError);
      expect(() => sandboxedAccess(arr, "map")).toThrow(SandboxViolationError);
      expect(() => sandboxedAccess(arr, "filter")).toThrow(SandboxViolationError);
    });
  });

  describe("Real-world attack vectors", () => {
    it("blocks constructor.constructor (Function constructor) escape", () => {
      const obj = {};
      expect(() => sandboxedAccess(obj, "constructor")).toThrow(SandboxViolationError);
    });

    it("blocks __proto__ manipulation", () => {
      const obj = {};
      expect(() => sandboxedAccess(obj, "__proto__")).toThrow(SandboxViolationError);
    });

    it("blocks prototype property access", () => {
      const fn = function () {};
      expect(() => sandboxedAccess(fn, "prototype")).toThrow(SandboxViolationError);
    });
  });

  describe("Well-known Symbol blocking", () => {
    it("blocks Symbol.toPrimitive access", () => {
      const obj = { [Symbol.toPrimitive]: () => 42 };
      expect(() => sandboxedAccess(obj, Symbol.toPrimitive)).toThrow(SandboxViolationError);
    });

    it("blocks Symbol.hasInstance access", () => {
      const obj = { [Symbol.hasInstance]: () => true };
      expect(() => sandboxedAccess(obj, Symbol.hasInstance)).toThrow(SandboxViolationError);
    });

    it("blocks Symbol.iterator access", () => {
      const obj = { [Symbol.iterator]: function* () { yield 1; } };
      expect(() => sandboxedAccess(obj, Symbol.iterator)).toThrow(SandboxViolationError);
    });

    it("blocks Symbol.asyncIterator access", () => {
      const obj = { [Symbol.asyncIterator]: async function* () { yield 1; } };
      expect(() => sandboxedAccess(obj, Symbol.asyncIterator)).toThrow(SandboxViolationError);
    });

    it("blocks Symbol.species access", () => {
      const obj = { [Symbol.species]: Array };
      expect(() => sandboxedAccess(obj, Symbol.species)).toThrow(SandboxViolationError);
    });

    it("allows non-well-known symbols (user symbols)", () => {
      const userSymbol = Symbol("user-data");
      const obj = { [userSymbol]: "safe value" };
      expect(sandboxedAccess(obj, userSymbol)).toBe("safe value");
    });

    it("sandboxedHas returns false for blocked symbols", () => {
      const obj = { [Symbol.toPrimitive]: () => 42 };
      expect(sandboxedHas(obj, Symbol.toPrimitive)).toBe(false);
    });

    it("sandboxedSet blocks well-known symbols", () => {
      const obj: any = {};
      expect(() => sandboxedSet(obj, Symbol.toPrimitive, () => 42)).toThrow(SandboxViolationError);
    });
  });

  describe("Additional boundary prototypes", () => {
    it("blocks WeakRef.prototype methods", () => {
      expect(isSandboxBoundary(WeakRef.prototype)).toBe(true);
    });

    it("blocks FinalizationRegistry.prototype methods", () => {
      expect(isSandboxBoundary(FinalizationRegistry.prototype)).toBe(true);
    });

    it("blocks SharedArrayBuffer.prototype methods", () => {
      expect(isSandboxBoundary(SharedArrayBuffer.prototype)).toBe(true);
    });

    it("blocks GeneratorFunction.prototype", () => {
      const genFn = function* () {};
      const genProto = Object.getPrototypeOf(genFn).prototype;
      expect(isSandboxBoundary(genProto)).toBe(true);
    });

    it("blocks AsyncGeneratorFunction.prototype", () => {
      const asyncGenFn = async function* () {};
      const asyncGenProto = Object.getPrototypeOf(asyncGenFn).prototype;
      expect(isSandboxBoundary(asyncGenProto)).toBe(true);
    });
  });

  describe("Cache invalidation", () => {
    it("markAsSandboxBoundary invalidates cache for plain objects", () => {
      const proto = { method() { return "test"; } };
      const child = Object.create(proto);
      child.ownProp = "own";

      // First access — proto is not a boundary, method is accessible
      expect(isSandboxBoundary(proto)).toBe(false);
      expect(sandboxedAccess(child, "method")).toBeInstanceOf(Function);

      // Mark proto as boundary
      markAsSandboxBoundary(proto);

      // Now proto should be a boundary — method should be blocked
      expect(isSandboxBoundary(proto)).toBe(true);
      expect(() => sandboxedAccess(child, "method")).toThrow(SandboxViolationError);

      // Own property still accessible
      expect(sandboxedAccess(child, "ownProp")).toBe("own");
    });
  });

  describe("isSandboxBoundary — global-constructor rule", () => {
    it("flags a global ctor's prototype that is NOT in the explicit list (TypeError)", () => {
      // TypeError is global, but TypeError.prototype is not enumerated in
      // BUILTIN_BOUNDARY_PROTOTYPES — the globalThis[name]===ctor rule covers it
      // (and every other global built-in we don't list, e.g. the Error subclasses).
      expect(isSandboxBoundary(TypeError.prototype)).toBe(true);
    });

    it("does NOT flag a local (non-global) class prototype; its own method stays reachable", () => {
      class Widget {
        greet() {
          return "hi";
        }
      }
      expect(isSandboxBoundary(Widget.prototype)).toBe(false);
      expect(sandboxedAccess(new Widget(), "greet")).toBeInstanceOf(Function);
    });

    it("does NOT falsely flag an ad-hoc object used as a prototype (own data stays reachable)", () => {
      // It inherits `constructor` from Object — the own-constructor guard keeps it
      // OFF the boundary set, so a child's access to its own data is not blocked.
      const proto = { helper: 1 };
      expect(isSandboxBoundary(proto)).toBe(false);
      expect(sandboxedAccess(Object.create(proto), "helper")).toBe(1);
    });

    it("is identity-checked: spoofing constructor.name = 'Object' is not a boundary", () => {
      // ctor.name === "Object" but globalThis.Object !== this impostor → not flagged.
      const impostor = { constructor: function Object() {} };
      expect(isSandboxBoundary(impostor)).toBe(false);
    });

    it("never invokes a hostile own accessor `constructor` (descriptor read, not [[Get]])", () => {
      let fired = false;
      const proto = {};
      Object.defineProperty(proto, "constructor", {
        get() {
          fired = true;
          return Object; // tries to masquerade as the real Object
        },
        configurable: true,
      });
      // The boundary read uses the own DESCRIPTOR's .value (undefined for an
      // accessor), so it neither fires the getter nor is fooled into a boundary.
      expect(isSandboxBoundary(proto)).toBe(false);
      expect(fired).toBe(false);
    });
  });
});
