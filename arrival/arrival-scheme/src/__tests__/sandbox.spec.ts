/**
 * Tests for the Sandbox Entry Point
 *
 * Verifies that the sandbox API provides:
 * - Pure Scheme functionality
 * - Pack-based JavaScript interop
 * - Custom bindings support
 * - Proper isolation
 */

import { describe, expect, it } from "vitest";
import { createSandbox, PURE_SCHEME_BINDINGS } from "../sandbox";
import { createLipsExtensionsPack, LIPS_EXTENSION_BINDINGS } from "../packs";

describe("Sandbox Entry Point", () => {
  describe("createSandbox", () => {
    it("should create a pure scheme sandbox", async () => {
      const sandbox = await createSandbox();

      // Should have pure scheme bindings
      const result = await sandbox.eval("(+ 1 2 3)");
      expect((result as { valueOf(): number }).valueOf()).toBe(6);

      // cons, car, cdr should work
      const listResult = await sandbox.eval("(car (cons 1 (cons 2 nil)))");
      expect((listResult as { valueOf(): number }).valueOf()).toBe(1);
    });

    it("should not have JavaScript interop by default", async () => {
      const sandbox = await createSandbox();

      // Math should not be available
      await expect(sandbox.eval("(Math.sqrt 4)")).rejects.toThrow(/Unbound/);
    });

    it("should support custom bindings", async () => {
      const sandbox = await createSandbox({
        bindings: {
          "my-value": 42,
          double: (x: number) => x * 2,
        },
      });

      const result = await sandbox.eval("(double my-value)");
      expect((result as { valueOf(): number }).valueOf()).toBe(84);
    });

    it("should support packs", async () => {
      const myPack = {
        id: "my-pack",
        bindings: {
          greet: (name: string) => `Hello, ${name}!`,
        },
      };

      const sandbox = await createSandbox({
        packs: [myPack],
      });

      const result = await sandbox.eval('(greet "World")');
      expect((result as { valueOf(): string }).valueOf()).toBe("Hello, World!");
    });
  });

  describe("Isolation", () => {
    it("should not share state between sandboxes", async () => {
      const sandbox1 = await createSandbox();
      const sandbox2 = await createSandbox();

      // Define in sandbox1
      await sandbox1.eval("(define x 1)");

      // Should not be visible in sandbox2
      await expect(sandbox2.eval("x")).rejects.toThrow(/Unbound/);
    });

    it("should not have access to forbidden operations", async () => {
      const sandbox = await createSandbox();

      // Node.js specific operations should not be available
      await expect(sandbox.eval("(process.exit 0)")).rejects.toThrow();
    });
  });

  describe("PURE_SCHEME_BINDINGS", () => {
    it("should export the list of pure scheme bindings", () => {
      expect(PURE_SCHEME_BINDINGS).toContain("cons");
      expect(PURE_SCHEME_BINDINGS).toContain("+");
      expect(PURE_SCHEME_BINDINGS).toContain("map");
      expect(PURE_SCHEME_BINDINGS).toContain("lambda");
    });
  });

  describe("createLipsExtensionsPack", () => {
    it("should provide LIPS-specific extensions", async () => {
      const sandbox = await createSandbox({
        packs: [await createLipsExtensionsPack()],
      });

      // LIPS operators like ** (exponentiation)
      const result = await sandbox.eval("(** 2 10)");
      expect((result as { valueOf(): number }).valueOf()).toBe(1024);
    });

    it("should export LIPS_EXTENSION_BINDINGS list", () => {
      expect(LIPS_EXTENSION_BINDINGS).toContain("**");
      expect(LIPS_EXTENSION_BINDINGS).toContain("%");
      expect(LIPS_EXTENSION_BINDINGS).toContain("type");
    });
  });
});
