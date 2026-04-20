/**
 * Tests for Environment Module Composition System
 *
 * Tests the composable module system where:
 * - Modules form an environment chain (first = base, last = top)
 * - Resolution order per module: bindings → resolvers → parent
 * - Resolvers can yield by returning undefined
 *
 * Note: These tests use _lookupWithResolvers directly to avoid
 * dependency on lips runtime (which patch_value requires).
 */

import { describe, expect, it } from "vitest";
import { Environment } from "../Environment";
import type { EnvironmentModule, FallbackResolver } from "../bindings";

// Helper to lookup without patch_value dependency
const lookup = (env: Environment, name: string) => env._lookupWithResolvers(name);

// Disable auto-load for tests that don't need lips runtime
const noAutoLoad = { autoLoadPureScheme: false };

describe("Environment Module Composition", () => {
  describe("Environment.fromModules", () => {
    it("should create environment from single module", () => {
      const module: EnvironmentModule = {
        id: "test-module",
        bindings: {
          foo: 42,
          bar: "hello",
        },
      };

      const env = Environment.fromModules([module], noAutoLoad);

      expect(env.__name__).toBe("test-module");
      expect(lookup(env, "foo")).toBe(42);
      expect(lookup(env, "bar")).toBe("hello");
    });

    it("should chain modules with parent relationships", () => {
      const baseModule: EnvironmentModule = {
        id: "base",
        bindings: { x: 1 },
      };

      const childModule: EnvironmentModule = {
        id: "child",
        bindings: { y: 2 },
      };

      const env = Environment.fromModules([baseModule, childModule], noAutoLoad);

      expect(env.__name__).toBe("child");
      expect(env.__parent__?.__name__).toBe("base");
      expect(lookup(env, "x")).toBe(1); // From base
      expect(lookup(env, "y")).toBe(2); // From child
    });

    it("should resolve dependencies in correct order", () => {
      const moduleA: EnvironmentModule = {
        id: "A",
        bindings: { a: 1 },
      };

      const moduleB: EnvironmentModule = {
        id: "B",
        dependencies: ["A"],
        bindings: { b: 2 },
      };

      const moduleC: EnvironmentModule = {
        id: "C",
        dependencies: ["B"],
        bindings: { c: 3 },
      };

      // Pass in any order - should sort by dependencies
      const env = Environment.fromModules([moduleC, moduleA, moduleB], noAutoLoad);

      expect(env.__name__).toBe("C");
      expect(lookup(env, "a")).toBe(1);
      expect(lookup(env, "b")).toBe(2);
      expect(lookup(env, "c")).toBe(3);

      // Verify parent chain order
      expect(env.__parent__?.__name__).toBe("B");
      expect(env.__parent__?.__parent__?.__name__).toBe("A");
    });

    it("should detect circular dependencies", () => {
      const moduleA: EnvironmentModule = {
        id: "A",
        dependencies: ["B"],
        bindings: {},
      };

      const moduleB: EnvironmentModule = {
        id: "B",
        dependencies: ["A"],
        bindings: {},
      };

      expect(() => Environment.fromModules([moduleA, moduleB], noAutoLoad)).toThrow(/Circular dependency/);
    });

    it("should throw on missing dependency", () => {
      const module: EnvironmentModule = {
        id: "test",
        dependencies: ["missing"],
        bindings: {},
      };

      expect(() => Environment.fromModules([module], noAutoLoad)).toThrow(/depends on unknown module/);
    });

    it("should throw on empty modules array", () => {
      expect(() => Environment.fromModules([], noAutoLoad)).toThrow(/No modules provided/);
    });
  });

  describe("Resolution Order", () => {
    it("should check bindings before resolvers within same module", () => {
      const resolveCalls: string[] = [];

      const resolver: FallbackResolver = {
        id: "test-resolver",
        resolve: (name) => {
          resolveCalls.push(name);
          return name === "foo" ? "from-resolver" : undefined;
        },
      };

      const module: EnvironmentModule = {
        id: "test",
        bindings: { foo: "from-binding" },
        resolver,
      };

      const env = Environment.fromModules([module], noAutoLoad);

      // Binding should be found without calling resolver
      expect(lookup(env, "foo")).toBe("from-binding");
      expect(resolveCalls).not.toContain("foo");

      // Resolver should be called for unknown symbols
      expect(lookup(env, "unknown")).toBe(undefined);
      expect(resolveCalls).toContain("unknown");
    });

    it("should check child bindings before parent bindings", () => {
      const baseModule: EnvironmentModule = {
        id: "base",
        bindings: { shared: "from-base", baseOnly: "base" },
      };

      const childModule: EnvironmentModule = {
        id: "child",
        bindings: { shared: "from-child", childOnly: "child" },
      };

      const env = Environment.fromModules([baseModule, childModule], noAutoLoad);

      expect(lookup(env, "shared")).toBe("from-child"); // Child shadows base
      expect(lookup(env, "baseOnly")).toBe("base");
      expect(lookup(env, "childOnly")).toBe("child");
    });

    it("should check child resolver before parent bindings", () => {
      const resolver: FallbackResolver = {
        id: "child-resolver",
        resolve: (name) => (name === "target" ? "from-child-resolver" : undefined),
      };

      const baseModule: EnvironmentModule = {
        id: "base",
        bindings: { target: "from-base-binding" },
      };

      const childModule: EnvironmentModule = {
        id: "child",
        bindings: {},
        resolver,
      };

      const env = Environment.fromModules([baseModule, childModule], noAutoLoad);

      // Child resolver should be tried before parent bindings
      expect(lookup(env, "target")).toBe("from-child-resolver");
    });

    it("should fall through to parent when child resolver yields", () => {
      const childResolver: FallbackResolver = {
        id: "child-resolver",
        resolve: () => undefined, // Always yields
      };

      const baseModule: EnvironmentModule = {
        id: "base",
        bindings: { value: "from-base" },
      };

      const childModule: EnvironmentModule = {
        id: "child",
        bindings: {},
        resolver: childResolver,
      };

      const env = Environment.fromModules([baseModule, childModule], noAutoLoad);

      expect(lookup(env, "value")).toBe("from-base");
    });
  });

  describe("Resolver Yielding", () => {
    it("should try multiple resolvers in order until one returns a value", () => {
      const callOrder: string[] = [];

      const resolver1: FallbackResolver = {
        id: "resolver-1",
        resolve: (name) => {
          callOrder.push("resolver-1");
          return undefined; // Yield
        },
      };

      const resolver2: FallbackResolver = {
        id: "resolver-2",
        resolve: (name) => {
          callOrder.push("resolver-2");
          return name === "target" ? "found" : undefined;
        },
      };

      const env = new Environment("test", {}, null);
      env.registerResolver(resolver1);
      env.registerResolver(resolver2);

      expect(lookup(env, "target")).toBe("found");
      expect(callOrder).toEqual(["resolver-1", "resolver-2"]);
    });

    it("should distinguish between undefined (yield) and null/nil (found)", () => {
      const resolver: FallbackResolver = {
        id: "null-resolver",
        resolve: (name) => (name === "null-value" ? null : undefined),
      };

      const env = new Environment("test", {}, null);
      env.registerResolver(resolver);

      // null is a valid return value, should not continue searching
      expect(lookup(env, "null-value")).toBe(null);
    });

    it("should walk parent chain with per-module resolution", () => {
      const resolutionPath: string[] = [];

      const baseResolver: FallbackResolver = {
        id: "base-resolver",
        resolve: (name) => {
          resolutionPath.push("base-resolver");
          return name === "base-only" ? "base-resolved" : undefined;
        },
      };

      const middleResolver: FallbackResolver = {
        id: "middle-resolver",
        resolve: (name) => {
          resolutionPath.push("middle-resolver");
          return name === "middle-only" ? "middle-resolved" : undefined;
        },
      };

      const topResolver: FallbackResolver = {
        id: "top-resolver",
        resolve: (name) => {
          resolutionPath.push("top-resolver");
          return name === "top-only" ? "top-resolved" : undefined;
        },
      };

      const base: EnvironmentModule = {
        id: "base",
        bindings: { base: "base-binding" },
        resolver: baseResolver,
      };

      const middle: EnvironmentModule = {
        id: "middle",
        bindings: { middle: "middle-binding" },
        resolver: middleResolver,
      };

      const top: EnvironmentModule = {
        id: "top",
        bindings: { top: "top-binding" },
        resolver: topResolver,
      };

      const env = Environment.fromModules([base, middle, top], noAutoLoad);

      // Test resolution of base-only symbol
      resolutionPath.length = 0;
      expect(lookup(env, "base-only")).toBe("base-resolved");
      // Should go through all resolvers in chain
      expect(resolutionPath).toEqual(["top-resolver", "middle-resolver", "base-resolver"]);

      // Bindings short-circuit at the level they're found, but resolvers
      // at higher levels are still called (per-module resolution order)
      resolutionPath.length = 0;
      expect(lookup(env, "base")).toBe("base-binding");
      // Top and middle resolvers are called (yield), then base's binding is found
      expect(resolutionPath).toEqual(["top-resolver", "middle-resolver"]);
    });
  });

  describe("_lookupWithResolvers", () => {
    it("should implement correct per-module resolution order", () => {
      const env = new Environment("parent", { x: 1 }, null);
      env.registerResolver({
        id: "parent-resolver",
        resolve: (name) => (name === "y" ? 2 : undefined),
      });

      const child = new Environment("child", { z: 3 }, env);
      child.registerResolver({
        id: "child-resolver",
        resolve: (name) => (name === "w" ? 4 : undefined),
      });

      // Direct binding in child
      expect(child._lookupWithResolvers("z")).toBe(3);

      // Resolver in child
      expect(child._lookupWithResolvers("w")).toBe(4);

      // Direct binding in parent (after child resolver yields)
      expect(child._lookupWithResolvers("x")).toBe(1);

      // Resolver in parent (after child resolver yields)
      expect(child._lookupWithResolvers("y")).toBe(2);

      // Not found anywhere
      expect(child._lookupWithResolvers("not-found")).toBe(undefined);
    });
  });

  describe("Module with Bootstrap Code", () => {
    it("should execute bootstrap code when exec is provided", () => {
      const executed: string[] = [];

      const module: EnvironmentModule = {
        id: "bootstrap-test",
        bindings: { initial: 1 },
        bootstrap: "(define derived 42)",
      };

      const mockExec = (code: string, env: Environment) => {
        executed.push(code);
        // Simulate setting the derived value
        env.set("derived", 42);
      };

      const env = Environment.fromModules([module], noAutoLoad, mockExec);

      expect(executed).toEqual(["(define derived 42)"]);
      // Note: env.set wraps numbers in SchemeExact, so check valueOf
      const derived = lookup(env, "derived") as { valueOf(): number };
      expect(derived.valueOf()).toBe(42);
    });

    it("should not execute bootstrap if no exec provided", () => {
      const module: EnvironmentModule = {
        id: "no-exec-test",
        bindings: { value: 1 },
        bootstrap: "(should-not-run)",
      };

      // Should not throw even with bootstrap code
      const env = Environment.fromModules([module], noAutoLoad);
      expect(lookup(env, "value")).toBe(1);
    });

    it("should execute bootstrap in dependency order", () => {
      const executed: string[] = [];

      const moduleA: EnvironmentModule = {
        id: "A",
        bootstrap: "bootstrap-A",
      };

      const moduleB: EnvironmentModule = {
        id: "B",
        dependencies: ["A"],
        bootstrap: "bootstrap-B",
      };

      const mockExec = (code: string) => executed.push(code);

      Environment.fromModules([moduleB, moduleA], noAutoLoad, mockExec);

      // A should be bootstrapped before B
      expect(executed).toEqual(["bootstrap-A", "bootstrap-B"]);
    });
  });

  describe("Environment.eval()", () => {
    it("should evaluate simple expressions", async () => {
      // Import lips to ensure runtime is loaded
      await import("../lips");

      const module: EnvironmentModule = {
        id: "test",
        bindings: {
          "+": (a: number, b: number) => a + b,
          "*": (a: number, b: number) => a * b,
        },
      };

      // Use noAutoLoad since we're providing our own + binding
      const env = Environment.fromModules([module], noAutoLoad);

      const result = await env.eval("(+ 1 2)");
      expect((result as { valueOf(): number }).valueOf()).toBe(3);
    });

    it("should evaluate multiple expressions and return last", async () => {
      await import("../lips");

      const module: EnvironmentModule = {
        id: "test",
        bindings: {
          "+": (a: number, b: number) => a + b,
        },
      };

      // Use noAutoLoad since we're providing our own + binding
      const env = Environment.fromModules([module], noAutoLoad);
      env.set("x", 10);

      const result = await env.eval("(+ 1 2) (+ x 5)");
      // Should return result of last expression
      expect((result as { valueOf(): number }).valueOf()).toBe(15);
    });

    it("should allow setting bindings that are visible to eval", async () => {
      await import("../lips");

      const module: EnvironmentModule = {
        id: "test",
        bindings: {
          "+": (a: number, b: number) => a + b,
        },
      };

      // Use noAutoLoad since we're providing our own + binding
      const env = Environment.fromModules([module], noAutoLoad);
      env.set("my-value", 42);

      const result = await env.eval("(+ my-value 1)");
      expect((result as { valueOf(): number }).valueOf()).toBe(43);
    });
  });

  describe("Practical Module Patterns", () => {
    it("should support layered sandboxing", () => {
      // Base: pure computation, no I/O
      const pureModule: EnvironmentModule = {
        id: "pure",
        bindings: {
          add: (a: number, b: number) => a + b,
          multiply: (a: number, b: number) => a * b,
        },
      };

      // Extension: adds controlled I/O
      const ioModule: EnvironmentModule = {
        id: "io",
        dependencies: ["pure"],
        bindings: {
          log: (...args: unknown[]) => console.log(...args),
        },
      };

      // Pure sandbox - no I/O access
      const pureEnv = Environment.fromModules([pureModule], noAutoLoad);
      expect(lookup(pureEnv, "add")).toBeDefined();
      expect(lookup(pureEnv, "log")).toBe(undefined); // Not available

      // Full sandbox - has I/O
      const fullEnv = Environment.fromModules([pureModule, ioModule], noAutoLoad);
      expect(lookup(fullEnv, "add")).toBeDefined();
      expect(lookup(fullEnv, "log")).toBeDefined();
    });

    it("should support resolver-based feature detection", () => {
      const featureResolver: FallbackResolver = {
        id: "features",
        resolve: (name) => {
          if (name === "has-math?") return true;
          if (name === "has-network?") return false;
          return undefined;
        },
      };

      const module: EnvironmentModule = {
        id: "feature-detection",
        bindings: {},
        resolver: featureResolver,
      };

      const env = Environment.fromModules([module], noAutoLoad);

      expect(lookup(env, "has-math?")).toBe(true);
      expect(lookup(env, "has-network?")).toBe(false);
    });

    it("should allow module to shadow parent resolver with binding", () => {
      const parentResolver: FallbackResolver = {
        id: "parent-math",
        resolve: (name) => (name === "pi" ? 3.14 : undefined),
      };

      const parentModule: EnvironmentModule = {
        id: "parent",
        resolver: parentResolver,
      };

      const childModule: EnvironmentModule = {
        id: "child",
        bindings: {
          pi: 3.14159265359, // More precise
        },
      };

      const env = Environment.fromModules([parentModule, childModule], noAutoLoad);

      // Child binding shadows parent resolver
      expect(lookup(env, "pi")).toBe(3.14159265359);
    });
  });

  describe("Auto-load Pure Scheme", () => {
    it("should auto-load pure scheme bindings when enabled", async () => {
      // Import from main entry point to ensure runtime and bridge are initialized
      await import("../index");

      const customModule: EnvironmentModule = {
        id: "custom",
        bindings: {
          "my-fn": () => "custom",
        },
      };

      // With auto-load enabled (default), pure scheme bindings should be available
      const env = Environment.fromModules([customModule]);

      // Custom binding should be available
      expect(lookup(env, "my-fn")).toBeDefined();

      // Pure scheme bindings should be available from the base
      expect(lookup(env, "cons")).toBeDefined();
      expect(lookup(env, "car")).toBeDefined();
      expect(lookup(env, "map")).toBeDefined();

      // The environment chain should include pure-scheme as base
      expect(env.__parent__?.__name__).toBe("pure-scheme");
    });

    it("should not auto-load when disabled", async () => {
      await import("../index");

      const customModule: EnvironmentModule = {
        id: "custom",
        bindings: {
          "my-fn": () => "custom",
        },
      };

      // With auto-load disabled
      const env = Environment.fromModules([customModule], { autoLoadPureScheme: false });

      // Custom binding should be available
      expect(lookup(env, "my-fn")).toBeDefined();

      // Pure scheme bindings should NOT be available
      expect(lookup(env, "cons")).toBeUndefined();
      expect(lookup(env, "+")).toBeUndefined();

      // No parent environment
      expect(env.__parent__).toBeNull();
    });

    it("should not duplicate pure-scheme if already in modules list", async () => {
      await import("../index");
      const { createPureSchemeModule } = await import("../modules/pure-scheme");
      const { global_env } = await import("../index");

      const pureScheme = createPureSchemeModule(global_env);
      const customModule: EnvironmentModule = {
        id: "custom",
        bindings: { "my-fn": () => "custom" },
      };

      // Pass pure-scheme explicitly
      const env = Environment.fromModules([pureScheme, customModule]);

      // Should only have one pure-scheme in chain
      let count = 0;
      let current: Environment | null = env;
      while (current) {
        if (current.__name__ === "pure-scheme") count++;
        current = current.__parent__;
      }
      expect(count).toBe(1);
    });

    it("should allow eval with auto-loaded pure scheme", async () => {
      // Import from main entry point to ensure runtime and bridge are initialized
      await import("../index");

      // Empty module - rely entirely on auto-loaded pure scheme
      const env = Environment.fromModules([{ id: "user", bindings: {} }]);

      // Verify pure scheme bindings are available
      expect(lookup(env, "+")).toBeDefined();
      expect(lookup(env, "cons")).toBeDefined();

      // Should be able to use pure scheme functions
      const result = await env.eval("(+ 1 2 3)");
      expect((result as { valueOf(): number }).valueOf()).toBe(6);

      const listResult = await env.eval("(car (list 1 2 3))");
      expect((listResult as { valueOf(): number }).valueOf()).toBe(1);
    });
  });
});
