/**
 * Test that Fantasy Land compatible Tree works with LIPS enhanced operations
 *
 * This demonstrates the RIGHT approach:
 * - Tree is a JS class with FL methods
 * - LIPS operations enhanced with FL support understand FL entities
 * - Data flows: FL entities → LIPS (via execSerialized) → results
 * - Full lifecycle: LIPS code calls FL methods on foreign objects
 */

import { describe, expect, it } from "vitest";
import { Tree, tree } from "./tree";
import { exec, lipsToJs, sandboxedEnv } from "@here.build/arrival-scheme";
import { execSerialized } from "../execSerialized";

describe("Tree + Fantasy Land Integration", () => {
  describe("Tree data structure", () => {
    it("should create simple tree", () => {
      const simpleTree = new Tree(1);

      expect(simpleTree.value).toBe(1);
      expect(simpleTree.children).toEqual([]);
      expect(simpleTree.toArray()).toEqual([1]);
    });

    it("should create tree with children", () => {
      //     1
      //    / \
      //   2   3
      const t = tree(1, tree(2), tree(3));

      expect(t.value).toBe(1);
      expect(t.children.length).toBe(2);
      expect(t.toArray()).toEqual([1, 2, 3]);
    });

    it("should create deep tree", () => {
      //       1
      //      / \
      //     2   3
      //    /   / \
      //   4   5   6
      const t = tree(1, tree(2, tree(4)), tree(3, tree(5), tree(6)));

      expect(t.toArray()).toEqual([1, 2, 4, 3, 5, 6]);
    });
  });

  describe("Tree Fantasy Land methods", () => {
    it("should have FL map method", () => {
      const t = tree(1, tree(2), tree(3));

      const mapped = t["fantasy-land/map"]((x: number) => x * 2);

      expect(mapped.toArray()).toEqual([2, 4, 6]);
    });

    it("should have FL filter method", () => {
      //       1
      //      / \
      //     2   3
      //    /   / \
      //   4   5   6
      const t = tree(1, tree(2, tree(4)), tree(3, tree(5), tree(6)));

      // Filter: keep only even numbers
      const filtered = t["fantasy-land/filter"]((x: number) => x % 2 === 0);

      // Root is 1 (odd), so entire tree is filtered out
      expect(filtered).toBe(null);
    });

    it("should have FL filter method that keeps matching subtrees", () => {
      //       2 (even - kept)
      //      / \
      //     1   4 (even - kept)
      //    /   / \
      //   3   5   6 (even - kept)
      const t = tree(2, tree(1, tree(3)), tree(4, tree(5), tree(6)));

      // Filter: keep only even numbers
      const filtered = t["fantasy-land/filter"]((x: number) => x % 2 === 0);

      expect(filtered).not.toBe(null);
      expect(filtered?.value).toBe(2);
      // Children: 1 is odd (filtered out), 4 is even (kept with its even child 6)
      expect(filtered?.toArray()).toEqual([2, 4, 6]);
    });

    it("should have FL reduce method", () => {
      const t = tree(1, tree(2), tree(3));

      const sum = t["fantasy-land/reduce"]((acc: number, x: number) => acc + x, 0);

      expect(sum).toBe(6); // 1 + 2 + 3
    });

    it("should reduce deep tree", () => {
      //       1
      //      / \
      //     2   3
      //    /   / \
      //   4   5   6
      const t = tree(1, tree(2, tree(4)), tree(3, tree(5), tree(6)));

      const sum = t["fantasy-land/reduce"]((acc: number, x: number) => acc + x, 0);

      expect(sum).toBe(21); // 1+2+4+3+5+6
    });
  });

  describe("Polymorphic operations with Tree", () => {
    it("should map over tree using LIPS map via execSerialized", async () => {
      const t = tree(1, tree(2), tree(3));

      console.log("Original tree:", t.toArray());

      // Use LIPS map via exec - full lifecycle test
      const mapped = lipsToJs(
        await exec("(map (lambda (x) (* x 10)) my-tree)", {
          env: sandboxedEnv.inherit({ "my-tree": t })
        }),
        {}
      );

      console.log("Mapped tree:", mapped);

      expect(mapped[0]).toBeInstanceOf(Tree);
      expect(mapped[0].toArray()).toEqual([10, 20, 30]);
    });

    it("should filter tree using LIPS filter via execSerialized", async () => {
      //       10
      //      /  \
      //     5    20
      //    /    /  \
      //   2   15   25
      const t = tree(10, tree(5, tree(2)), tree(20, tree(15), tree(25)));

      console.log("Original tree:", t.toArray());

      // Use LIPS filter via exec - full lifecycle test
      const filtered = lipsToJs(
        await exec("(filter (lambda (x) (>= x 10)) my-tree)", {
          env: sandboxedEnv.inherit({ "my-tree": t })
        }),
        {}
      )[0];

      console.log("Filtered tree:", filtered?.toArray());

      expect(filtered).toBeInstanceOf(Tree);
      expect(filtered?.toArray()).toEqual([10, 20, 15, 25]);
    });

    it("should reduce tree using LIPS reduce via execSerialized", async () => {
      const t = tree(1, tree(2, tree(4)), tree(3, tree(5), tree(6)));

      console.log("Tree values:", t.toArray());

      // Use LIPS reduce via exec - full lifecycle test
      const sum = lipsToJs(
        await exec("(reduce add 0 my-tree)", {
          env: sandboxedEnv.inherit({ "my-tree": t })
        }),
        { forceBigInt: true }
      )[0];

      console.log("Sum:", sum);

      // Result should be native BigInt (unwrapped by lipsToJs)
      expect(sum).toBe(21n);
    });

    it("should work with complex tree operations via LIPS", async () => {
      // Create a file system tree
      interface File {
        name: string;
        size: number;
      }

      const fs = tree<File>(
        { name: "root", size: 0 },
        tree({ name: "src", size: 0 }, tree({ name: "index.ts", size: 100 }), tree({ name: "utils.ts", size: 50 })),
        tree(
          { name: "tests", size: 0 },
          tree({ name: "index.test.ts", size: 200 }),
          tree({ name: "utils.test.ts", size: 150 })
        )
      );

      // Map: extract just the names via LIPS
      const names = lipsToJs(
        await exec('(map (lambda (f) (prop "name" f)) fs-tree)', {
          env: sandboxedEnv.inherit({ "fs-tree": fs })
        }),
        {}
      )[0];
      console.log("File names:", names.toArray());
      expect(names.toArray()).toEqual([
        "root",
        "src",
        "index.ts",
        "utils.ts",
        "tests",
        "index.test.ts",
        "utils.test.ts"
      ]);

      // Filter: keep only actual files (size > 0) via LIPS
      const files = lipsToJs(
        await exec('(filter (lambda (f) (> (prop "size" f) 0)) fs-tree)', {
          env: sandboxedEnv.inherit({ "fs-tree": fs })
        }),
        {}
      )[0];
      console.log(
        "Actual files:",
        files?.toArray().map((f: File) => f.name)
      );
      // Root has size 0, so entire tree filtered out
      expect(files).toBe(null);

      // Reduce: calculate total size of all files via LIPS
      const totalSize = lipsToJs(
        await exec('(reduce (lambda (acc f) (add acc (prop "size" f))) 0 fs-tree)', {
          env: sandboxedEnv.inherit({ "fs-tree": fs })
        }),
        { forceBigInt: true }
      )[0];
      console.log("Total size:", totalSize);
      // Result should be native BigInt (unwrapped by lipsToJs)
      expect(totalSize).toBe(500n);
    });

    it("should demonstrate the right direction: FL entities → LIPS operations", async () => {
      // This is the key test: we create a JS object with FL methods,
      // and LIPS operations understand it natively through enhanced wrappers

      const ast = tree("program", tree("function", tree("param"), tree("body")), tree("return", tree("value")));

      console.log("\nOriginal AST:");
      console.log(ast.toString());

      // LIPS map via enhanced wrapper automatically uses FL method
      const uppercased = lipsToJs(
        await exec("(map to-upper ast-tree)", {
          env: sandboxedEnv.inherit({ "ast-tree": ast })
        }),
        {}
      )[0];

      console.log("\nUppercased AST:");
      console.log(uppercased.toString());

      expect(uppercased.toArray()).toEqual(["PROGRAM", "FUNCTION", "PARAM", "BODY", "RETURN", "VALUE"]);

      // Count nodes via LIPS reduce
      const nodeCount = lipsToJs(
        await exec("(reduce (lambda (acc _) (add acc 1)) 0 ast-tree)", {
          env: sandboxedEnv.inherit({ "ast-tree": ast })
        }),
        { forceBigInt: true }
      )[0];
      // Result should be native BigInt (unwrapped by lipsToJs)
      expect(nodeCount).toBe(6n);
    });
  });

  describe("Mixed LIPS + Tree operations", () => {
    it("should work with trees in LIPS environment", async () => {
      // Use LIPS to map over it
      const result = lipsToJs(
        await exec(`(map (lambda (x) (add x 1)) my-tree)`, {
          env: sandboxedEnv.inherit({
            "my-tree": tree(1, tree(2), tree(3))
          })
        }),
        {}
      );

      console.log("LIPS map over Tree result:", result);
      console.log("Result array:", result[0]?.toArray());

      expect(result[0]).toBeInstanceOf(Tree);
      expect(result[0].toArray()).toEqual([2, 3, 4]);
    });

    it("should compose LIPS and Tree operations", async () => {
      const env = sandboxedEnv.inherit({ "my-tree": tree(1, tree(2), tree(3)) });
      const value = lipsToJs(
        await exec(`(reduce add 0 my-tree)`, {
          env
        }),
        { forceBigInt: true }
      );

      console.log("LIPS reduce over Tree:", value);

      // Result should be native BigInt (unwrapped by execSerialized)
      expect(value).toEqual([6n]); // 1 + 2 + 3
    });
  });
});
