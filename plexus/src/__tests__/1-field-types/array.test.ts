/**
 * Array Field Tests (@syncing.list)
 *
 * Tests for array field behavior including:
 * - Proxy trap edge cases (negative indices, length manipulation)
 * - Complex array operations (pop/shift/splice/reverse)
 * - Cross-document synchronization
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// ============================================
// Test Models
// ============================================

@syncing("Component")
class Component extends PlexusModel {
  @syncing accessor name!: string;
  @syncing accessor type!: string;
  @syncing.child.list accessor children: Component[] = [];
  @syncing.list accessor tags: string[] = []; // Non-child field for testing sparse arrays
  @syncing.record accessor metadata: Record<string, string> = {};
}

@syncing("Site")
class Site extends PlexusModel {
  @syncing accessor name!: string;
  @syncing.record accessor components!: Record<string, Component>;
}

// ============================================
// Helper Functions
// ============================================

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

function createTestSite(name: string): { site: Site; entityId: string; doc: Y.Doc } {
  const ephemeralSite = new Site({ name, components: {} });
  const { doc, root: site } = initTestPlexus<Site>(ephemeralSite);
  return { site, entityId: site.uuid, doc };
}

// ============================================
// Tests
// ============================================

describe("array field (@syncing.list)", () => {
  let doc1: Y.Doc;
  let doc2: Y.Doc;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  describe("Proxy Trap Edge Cases", () => {
    it("should handle negative array indices", () => {
      const { site } = createTestSite("Negative Index Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });

      const child = new Component({ name: "Child", type: "child", children: [], metadata: {} });
      parent.children.push(child);

      site.components["parent"] = parent;

      // Test negative indices (should warn and throw TypeError for invalid index)
      expect(() => {
        parent.children[-1] = child;
      }).to.throw();

      // Should still have only one child
      expect([parent.children.length, parent.children[0].name]).to.have.ordered.members([1, "Child"]);
    });

    it("should handle array length manipulation", () => {
      const { site } = createTestSite("Length Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });

      // Add several children
      for (let i = 0; i < 5; i++) {
        parent.children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: {},
          }),
        );
      }

      site.components["parent"] = parent;
      expect(parent.children).to.have.lengthOf(5);

      // Truncate by setting length
      parent.children.length = 2;

      expect([
        parent.children.length,
        parent.children[0].name,
        parent.children[1].name,
        parent.children[2],
      ]).to.have.ordered.members([2, "Child0", "Child1", undefined]);
    });

    it("should handle assignment at arr[length] like normal arrays", () => {
      const { site } = createTestSite("Index at Length Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });
      site.components["parent"] = parent;

      // Start with 2 children
      parent.children.push(
        new Component({ name: "Child0", type: "child", children: [], metadata: {} }),
        new Component({ name: "Child1", type: "child", children: [], metadata: {} }),
      );

      expect(parent.children).to.have.lengthOf(2);

      // Compare with normal JS array behavior
      const jsArray: (Component | null)[] = [
        new Component({ name: "JSChild0", type: "child", children: [], metadata: {} }),
        new Component({ name: "JSChild1", type: "child", children: [], metadata: {} }),
      ];

      // Assign at [length] - should append (like push)
      const newChild = new Component({ name: "Child2", type: "child", children: [], metadata: {} });
      parent.children[parent.children.length] = newChild;

      const jsNewChild = new Component({ name: "JSChild2", type: "child", children: [], metadata: {} });
      jsArray[jsArray.length] = jsNewChild;

      // Both should append successfully
      expect(parent.children.map((c: Component | null) => c?.name)).to.deep.equal(["Child0", "Child1", "Child2"]);
      expect(jsArray.map((c) => c?.name)).to.deep.equal(["JSChild0", "JSChild1", "JSChild2"]);
    });

    it("should handle assignment at arr[length + 1] like normal arrays", () => {
      const { site } = createTestSite("Index Beyond Length Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });
      site.components["parent"] = parent;

      // Start with 2 children
      parent.children.push(
        new Component({ name: "Child0", type: "child", children: [], metadata: {} }),
        new Component({ name: "Child1", type: "child", children: [], metadata: {} }),
      );

      expect(parent.children).to.have.lengthOf(2);

      // Compare with normal JS array behavior
      const jsArray: (Component | null)[] = [
        new Component({ name: "JSChild0", type: "child", children: [], metadata: {} }),
        new Component({ name: "JSChild1", type: "child", children: [], metadata: {} }),
      ];

      // Assign at [length + 1] - should create a hole at [length]
      parent.children[parent.children.length + 1] = new Component({
        name: "Child3",
        type: "child",
        children: [],
        metadata: {},
      });

      jsArray[jsArray.length + 1] = new Component({ name: "JSChild3", type: "child", children: [], metadata: {} });

      // Both should create same structure with one hole: [item0, item1, null, item3]
      expect(parent.children.map((c: Component | null) => c?.name)).to.deep.equal([
        "Child0",
        "Child1",
        undefined,
        "Child3",
      ]);
      expect(jsArray.map((c) => c?.name)).to.deep.equal(["JSChild0", "JSChild1", undefined, "JSChild3"]);
    });

    it("should handle assignment at arr[length + 5] like normal arrays", () => {
      const { site } = createTestSite("Large Gap Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });
      site.components["parent"] = parent;

      // Start with 2 children
      parent.children.push(
        new Component({ name: "Child0", type: "child", children: [], metadata: {} }),
        new Component({ name: "Child1", type: "child", children: [], metadata: {} }),
      );

      expect(parent.children).to.have.lengthOf(2);

      // Compare with normal JS array behavior
      const jsArray: (Component | null)[] = [
        new Component({ name: "JSChild0", type: "child", children: [], metadata: {} }),
        new Component({ name: "JSChild1", type: "child", children: [], metadata: {} }),
      ];

      // Assign at [length + 5] - should create multiple holes
      parent.children[parent.children.length + 5] = new Component({
        name: "Child7",
        type: "child",
        children: [],
        metadata: {},
      });

      jsArray[jsArray.length + 5] = new Component({ name: "JSChild7", type: "child", children: [], metadata: {} });

      // Both should have same length with holes
      expect(parent.children).to.have.lengthOf(8);
      expect(jsArray).to.have.lengthOf(8);

      // Validate final structure: [child0, child1, null, null, null, null, null, child7]
      expect(parent.children.map((c: Component | null) => c?.name)).to.deep.equal([
        "Child0",
        "Child1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "Child7",
      ]);

      // JS array should match same pattern with its items
      expect(jsArray.map((c) => c?.name)).to.deep.equal([
        "JSChild0",
        "JSChild1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "JSChild7",
      ]);
    });

    it("should handle assignment at arr[length] with existing child item (move to end)", () => {
      const { site } = createTestSite("Move Child to End Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });
      site.components["parent"] = parent;

      // Start with 3 children
      const child0 = new Component({ name: "Child0", type: "child", children: [], metadata: {} });
      const child1 = new Component({ name: "Child1", type: "child", children: [], metadata: {} });
      const child2 = new Component({ name: "Child2", type: "child", children: [], metadata: {} });

      parent.children.push(child0, child1, child2);
      expect(parent.children).to.have.lengthOf(3);

      // CHILD field behavior (splice semantics, not hole-preservation):
      // arr[3] = child0 (where child0 is at index 0)
      // 1. Detect reuse: child0 exists at index 0
      // 2. splice(0, 1) → [child1, child2] (length 2)
      // 3. Adjust target: 3 - 1 = 2 (since existingIndex < parsedElementKey)
      // 4. Set arr[2] = child0 → [child1, child2, child0]
      const lengthBeforeAssign = parent.children.length;
      parent.children[lengthBeforeAssign] = child0;

      // Expected: [child1, child2, child0] - child0 moved to end
      expect(parent.children).to.deep.equal([child1, child2, child0]);
      expect(parent.children.filter((c) => c === child0)).to.have.lengthOf(1);
    });

    it("should handle assignment at arr[2] when length=2 - child field", () => {
      const { site } = createTestSite("Child vs JS Array Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });
      site.components["parent"] = parent;

      // CHILD field (children array) - tests reuse behavior with splice semantics
      const child0 = new Component({ name: "Child0", type: "child", children: [], metadata: {} });
      const child1 = new Component({ name: "Child1", type: "child", children: [], metadata: {} });
      parent.children.push(child0, child1);

      // Normal JS array for comparison
      const jsChildArray: Component[] = [child0, child1];

      // Assign existing child at [2] (arr.length = 2, so this is arr[length])
      parent.children[2] = child0; // Plexus: uses splice semantics
      jsChildArray[2] = child0; // JS: creates duplicate

      // JS behavior: [child0, child1, child0] - length 3, child0 appears twice
      expect(jsChildArray).to.deep.equal([child0, child1, child0]);
      expect(jsChildArray.filter((c) => c === child0)).to.have.lengthOf(2); // 2 instances

      // CHILD field behavior (splice semantics):
      // arr[2] = child0 (where child0 is at index 0)
      // 1. Detect reuse: child0 exists at index 0
      // 2. splice(0, 1) → [child1] (length 1)
      // 3. Adjust target: 2 - 1 = 1 (since existingIndex < parsedElementKey)
      // 4. Set arr[1] = child0 → [child1, child0]
      expect(parent.children).to.deep.equal([child1, child0]);
      expect(parent.children.filter((c) => c === child0)).to.have.lengthOf(1); // Only 1 instance
    });

    it("should handle assignment at arr[length + n] with holes - child field", () => {
      const { site } = createTestSite("Child Holes Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });
      site.components["parent"] = parent;

      // Start with 2 children
      const child0 = new Component({ name: "Child0", type: "child", children: [], metadata: {} });
      const child1 = new Component({ name: "Child1", type: "child", children: [], metadata: {} });
      parent.children.push(child0, child1);

      // Assign at [5] - should create holes at [2], [3], [4]
      const child5 = new Component({ name: "Child5", type: "child", children: [], metadata: {} });
      parent.children[5] = child5;

      // Initial state: [child0, child1, null, null, null, child5]
      expect(parent.children).to.deep.equal([child0, child1, null, null, null, child5]);

      // CHILD field behavior (splice semantics):
      // arr[3] = child0 (where child0 is at index 0)
      // Initial: [child0, child1, null, null, null, child5] (length 6)
      // 1. Detect reuse: child0 exists at index 0
      // 2. splice(0, 1) → [child1, null, null, null, child5] (length 5)
      // 3. Adjust target: 3 - 1 = 2 (since existingIndex < parsedElementKey)
      // 4. Set arr[2] = child0 (replaces the null) → [child1, null, child0, null, child5]
      parent.children[3] = child0;

      // Expected: [child1, null, child0, null, child5] - length 5
      expect(parent.children).to.deep.equal([child1, null, child0, null, child5]);
      expect(parent.children.filter((c) => c === child0)).to.have.lengthOf(1);
    });
  });

  describe("Complex Array Operations", () => {
    it("should handle complex array method combinations", () => {
      const { site } = createTestSite("Complex Array Test");

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });

      // Create initial children
      const children: Component[] = [];
      for (let i = 0; i < 5; i++) {
        children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: {},
          }),
        );
      }

      parent.children.push(...children);
      site.components["parent"] = parent;

      // Test complex operations
      const popped = parent.children.pop();
      expect(popped?.name).to.equal("Child4");
      expect(parent.children).to.have.lengthOf(4);

      const shifted = parent.children.shift();
      expect(shifted?.name).to.equal("Child0");
      expect(parent.children).to.have.lengthOf(3);

      // Splice operation
      const newChild = new Component({ name: "NewChild", type: "child", children: [], metadata: {} });
      const spliced = parent.children.splice(1, 1, newChild);
      expect(spliced).to.have.lengthOf(1);
      expect(spliced[0].name).to.equal("Child2");
      expect(parent.children).to.have.lengthOf(3);
      expect(parent.children[1].name).to.equal("NewChild");

      // Reverse
      parent.children.reverse();
      expect(parent.children[0].name).to.equal("Child3");
      expect(parent.children[1].name).to.equal("NewChild");
      expect(parent.children[2].name).to.equal("Child1");
    });

    it("should sync complex array operations across documents", () => {
      const { site: site1, doc: doc1 } = createTestSite("Complex Sync Test");
      const doc2 = new Y.Doc({ guid: doc1.guid });

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {},
      });

      // Add initial children
      for (let i = 0; i < 3; i++) {
        parent.children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: {},
          }),
        );
      }

      site1.components["parent"] = parent;

      // Initial sync
      syncDocs(doc1, doc2);

      const { root: site2 } = connectTestPlexus<Site>(doc2);
      const parent1 = site1.components["parent"];
      const parent2 = site2.components["parent"];

      // Perform complex operations on doc1
      parent1.children.reverse();
      parent1.children.pop();

      // Sync changes
      syncDocs(doc1, doc2);

      // Verify doc2 reflects changes
      // Expected: reverse() [Child2, Child1, Child0] then pop() removes Child0 -> [Child2, Child1]
      expect(parent2.children).to.have.lengthOf(2);
      expect(parent2.children[0].name).to.equal("Child2");
      expect(parent2.children[1].name).to.equal("Child1");
    });
  });

  describe("Child Array Reuse - Index Assignment", () => {
    let parent: Component;
    let indexed: Record<string, Component> = {};
    beforeEach(() => {
      const { site } = createTestSite("Reuse Index Test");
      parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = ["a", "b", "c", "d", "e"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      indexed = Object.fromEntries(parent.children.map((c) => [c.name, c]));
    });
    it.each([
      { index: 2, item: "b", desc: "b from earlier position (1)", expected: ["a", "b", "d", "e"] },
      { index: 2, item: "c", desc: "c from same position (2) - no-op", expected: ["a", "b", "c", "d", "e"] },
      { index: 2, item: "d", desc: "d from later position (3)", expected: ["a", "b", "d", "e"] },
    ])("should handle arr[$index] = $item ($desc)", ({ index, item, expected }) => {
      parent.children[index] = indexed[item];
      expect(parent.children).to.deep.equal(expected.map((name) => indexed[name]));
    });
  });

  describe("Child Array Reuse - push", () => {
    let parent: Component;
    let indexed: Record<string, Component> = {};
    beforeEach(() => {
      const { site } = createTestSite("Push Reuse Test");
      parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = ["a", "b", "c", "d", "e"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      indexed = Object.fromEntries(parent.children.map((c) => [c.name, c]));
    });
    it.each([
      { item: "a", desc: "a from first position (0)", expected: ["b", "c", "d", "e", "a"] },
      { item: "c", desc: "c from middle position (2)", expected: ["a", "b", "d", "e", "c"] },
      { item: "e", desc: "e from last position (4) - no-op", expected: ["a", "b", "c", "d", "e"] },
    ])("should handle push($item) - $desc", ({ item, expected }) => {
      parent.children.push(indexed[item]);
      expect(parent.children).to.deep.equal(expected.map((name) => indexed[name]));
    });
  });

  describe("Child Array Reuse - unshift", () => {
    let parent: Component;
    let indexed: Record<string, Component> = {};
    beforeEach(() => {
      const { site } = createTestSite("Unshift Reuse Test");
      parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = ["a", "b", "c", "d", "e"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      indexed = Object.fromEntries(parent.children.map((c) => [c.name, c]));
    });
    it.each([
      { item: "e", desc: "e from last position (4)", expected: ["e", "a", "b", "c", "d"] },
      { item: "c", desc: "c from middle position (2)", expected: ["c", "a", "b", "d", "e"] },
      { item: "a", desc: "a from first position (0) - no-op", expected: ["a", "b", "c", "d", "e"] },
    ])("should handle unshift($item) - $desc", ({ item, expected }) => {
      parent.children.unshift(indexed[item]);
      expect(parent.children).to.deep.equal(expected.map((name) => indexed[name]));
    });
  });

  describe("Child Array Reuse - splice", () => {
    let parent: Component;
    let indexed: Record<string, Component> = {};
    beforeEach(() => {
      const { site } = createTestSite("Splice Reuse Test");
      parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = ["a", "b", "c", "d", "e"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      indexed = Object.fromEntries(parent.children.map((c) => [c.name, c]));
    });

    describe("Single item replacement at index 2", () => {
      it.each([
        { insert: ["b"], desc: "b from earlier position (1)", expected: ["a", "b", "d", "e"] },
        { insert: ["c"], desc: "c from same position (2) - no-op", expected: ["a", "b", "c", "d", "e"] },
        { insert: ["d"], desc: "d from later position (3)", expected: ["a", "b", "d", "e"] },
        { insert: ["b", "c"], desc: "[b,c] with c in overlap", expected: ["a", "b", "c", "d", "e"] },
        { insert: ["c", "d"], desc: "[c,d] with both in/near zone", expected: ["a", "b", "c", "d", "e"] },
        { insert: ["a", "b"], desc: "[a,b] both from earlier", expected: ["a", "b", "d", "e"] },
        { insert: ["d", "e"], desc: "[d,e] both from later", expected: ["a", "b", "d", "e"] },
      ])("should handle splice(2, 1, $insert) - $desc", ({ insert, expected }) => {
        parent.children.splice(2, 1, ...insert.map((name) => indexed[name]));
        expect(parent.children).to.deep.equal(expected.map((name) => indexed[name]));
      });
    });

    describe("Replace bcd (indices 1-3) with various items", () => {
      it.each([
        { insert: ["a"], desc: "a from before zone", expected: ["a", "e"] },
        { insert: ["b"], desc: "b from within zone", expected: ["a", "b", "e"] },
        { insert: ["c"], desc: "c from within zone", expected: ["a", "c", "e"] },
        { insert: ["d"], desc: "d from within zone", expected: ["a", "d", "e"] },
        { insert: ["a", "b"], desc: "[a,b] mixed before/in zone", expected: ["a", "b", "e"] },
        { insert: ["b", "c"], desc: "[b,c] both in zone", expected: ["a", "b", "c", "e"] },
        { insert: ["a", "b", "c"], desc: "[a,b,c] mixed", expected: ["a", "b", "c", "e"] },
        { insert: ["a", "b", "c", "d"], desc: "[a,b,c,d] all removed items", expected: ["a", "b", "c", "d", "e"] },
      ])("should handle splice(1, 3, $insert) - $desc", ({ insert, expected }) => {
        parent.children.splice(1, 3, ...insert.map((name) => indexed[name]));
        expect(parent.children).to.deep.equal(expected.map((name) => indexed[name]));
      });
    });

    it("should handle splice(1, 4, b, c, d, e) - replace all with same (no-op)", () => {
      parent.children.splice(1, 4, indexed.b, indexed.c, indexed.d, indexed.e);
      expect(parent.children).to.deep.equal([indexed.a, indexed.b, indexed.c, indexed.d, indexed.e]);
    });
  });

  describe("Child Array Reuse - copyWithin", () => {
    let parent: Component;
    let indexed: Record<string, Component> = {};
    beforeEach(() => {
      const { site } = createTestSite("Reuse copyWithin Test");
      parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = ["a", "b", "c", "d", "e"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      indexed = Object.fromEntries(parent.children.map((c) => [c.name, c]));
    });

    it.each([
      {
        args: [0, 3, 5] as const,
        desc: "copyWithin(0, 3, 5) - would copy d,e to start creating duplicates",
        reason: "Copies d,e to 0,1 creating [d,e,c,d,e] - duplicate d,e not allowed",
      },
      {
        args: [2, 0, 2] as const,
        desc: "copyWithin(2, 0, 2) - would copy a,b to position 2 creating duplicates",
        reason: "Copies a,b to 2,3 creating [a,b,a,b,e] - duplicate a,b not allowed",
      },
      {
        args: [1, 2] as const,
        desc: "copyWithin(1, 2) - would copy c,d,e to position 1 creating duplicates",
        reason: "Copies c,d,e to 1,2,3 creating [a,c,d,e,e] - duplicate e not allowed",
      },
      {
        args: [-2, 0, 2] as const,
        desc: "copyWithin(-2, 0, 2) - would copy a,b to end creating duplicates",
        reason: "Copies a,b to 3,4 creating [a,b,c,a,b] - duplicate a,b not allowed",
      },
    ])("should throw when $desc", ({ args, reason }) => {
      expect(() => {
        parent.children.copyWithin(...(args as [number, number, number]));
      }).toThrow("copyWithin cannot insert the same child multiple times");
      // Array should remain unchanged after error
      expect(parent.children).to.deep.equal([indexed.a, indexed.b, indexed.c, indexed.d, indexed.e]);
    });

    it("should handle copyWithin when no duplicates created (no-op case)", () => {
      // copyWithin(0, 0, 5) copies items to their own positions - no duplicates
      parent.children.copyWithin(0, 0, 5);
      expect(parent.children).to.deep.equal([indexed.a, indexed.b, indexed.c, indexed.d, indexed.e]);
      for (const child of parent.children) {
        expect(child.parent).to.equal(parent);
      }
    });

    it("should handle copyWithin when no duplicates created (non-overlapping empty range)", () => {
      // copyWithin(2, 2, 2) copies nothing - no-op
      parent.children.copyWithin(2, 2, 2);
      expect(parent.children).to.deep.equal([indexed.a, indexed.b, indexed.c, indexed.d, indexed.e]);
    });
  });

  describe("Reactivity and No-Op Detection", () => {
    it("should not trigger modifications for self-assignment", () => {
      const { site } = createTestSite("No-Op Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = [
        new Component({ name: "a", type: "child", children: [], metadata: {} }),
        new Component({ name: "b", type: "child", children: [], metadata: {} }),
      ];

      // Track modifications
      let modificationCount = 0;
      const trackFn = () => modificationCount++;

      // Self-assignment should be no-op
      const item = parent.children[0];
      parent.children[0] = item;

      expect(modificationCount).to.equal(0);
      expect(parent.children).toHaveLength(2);
    });

    it("should not trigger modifications for splice(0, 0) - empty insert at start", () => {
      const { site } = createTestSite("No-Op Splice Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      parent.children = [
        new Component({ name: "a", type: "child", children: [], metadata: {} }),
        new Component({ name: "b", type: "child", children: [], metadata: {} }),
      ];

      const lengthBefore = parent.children.length;
      parent.children.splice(0, 0); // Insert nothing at position 0

      expect(parent.children).toHaveLength(lengthBefore);
    });

    it("should not trigger modifications for push of last item", () => {
      const { site } = createTestSite("No-Op Push Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      const items = [
        new Component({ name: "a", type: "child", children: [], metadata: {} }),
        new Component({ name: "b", type: "child", children: [], metadata: {} }),
      ];
      parent.children = items;

      // Pushing the last item should be treated as no-op (item already at end)
      const lastItem = parent.children.at(-1)!;
      const lengthBefore = parent.children.length;
      parent.children.push(lastItem);

      // After deduplication, should be same length (moved from end to end = no-op)
      expect(parent.children).toHaveLength(lengthBefore);
      expect(parent.children.at(-1)).to.equal(lastItem);
    });

    it("should trigger modifications for actual changes", () => {
      const { site } = createTestSite("Real Modification Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      const [a, b, c] = [
        new Component({ name: "a", type: "child", children: [], metadata: {} }),
        new Component({ name: "b", type: "child", children: [], metadata: {} }),
        new Component({ name: "c", type: "child", children: [], metadata: {} }),
      ];
      parent.children = [a, b];

      // Real change: pushing new item
      parent.children.push(c);
      expect(parent.children).toHaveLength(3);
      expect(parent.children[2]).to.equal(c);

      // Real change: moving item
      parent.children[0] = b;
      expect(parent.children).to.deep.equal([b, c]);
      expect(parent.children).toHaveLength(2);
    });

    it("should handle unshift of first item as no-op", () => {
      const { site } = createTestSite("No-Op Unshift Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      const items = [
        new Component({ name: "a", type: "child", children: [], metadata: {} }),
        new Component({ name: "b", type: "child", children: [], metadata: {} }),
      ];
      parent.children = items;

      const firstItem = parent.children[0];
      const lengthBefore = parent.children.length;
      parent.children.unshift(firstItem);

      // After deduplication, should be same length (moved from start to start = no-op)
      expect(parent.children).toHaveLength(lengthBefore);
      expect(parent.children[0]).to.equal(firstItem);
    });

    it("should track parent relationships correctly during operations", () => {
      const { site } = createTestSite("Parent Tracking Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;
      const item = new Component({ name: "item", type: "child", children: [], metadata: {} });

      // Initially no parent
      expect(item.parent).to.eq(null);

      // Push sets parent
      parent.children.push(item);
      expect(item.parent).to.equal(parent);

      // Move within same array maintains parent
      parent.children[1] = item;
      expect(item.parent).to.equal(parent);

      // Splice out removes parent
      parent.children.splice(0);
      expect(item.parent).to.eq(null);
    });
  });

  describe("Adoption Order Edge Cases", () => {
    it("should handle adoption order correctly when replacing with new child", () => {
      const { site } = createTestSite("Adoption Order Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;

      const a = new Component({ name: "a", type: "child", children: [], metadata: {} });
      const b = new Component({ name: "b", type: "child", children: [], metadata: {} });
      parent.children.push(a);

      // This should not cause infinite loop or inconsistent state
      // The old item 'a' should be orphanized before 'b' is adopted
      parent.children[0] = b;

      expect(parent.children).to.deep.equal([b]);
      expect(a.parent).to.eq(null);
      expect(b.parent).to.equal(parent);
    });

    it("should handle adoption order when moving child within same array", () => {
      const { site } = createTestSite("Adoption Order Move Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;

      const [a, b, c] = ["a", "b", "c"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      parent.children.push(a, b, c);

      // Moving 'a' to position 1 should not cause:
      // - Duplicate detection errors
      // - Infinite loops in validation
      // - Inconsistent parent state
      parent.children[1] = a;

      expect(parent.children).to.deep.equal([a, c]);
      expect(a.parent).to.equal(parent);
      expect(b.parent).to.eq(null);
      expect(c.parent).to.equal(parent);
    });

    it("should handle adoption order with nested validation checks", () => {
      const { site } = createTestSite("Nested Validation Test");
      const grandparent = new Component({ name: "Grandparent", type: "container", children: [], metadata: {} });
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      const child = new Component({ name: "Child", type: "child", children: [], metadata: {} });

      site.components.grandparent = grandparent;
      grandparent.children.push(parent);
      parent.children.push(child);

      // Verify initial hierarchy
      expect(grandparent.children).to.deep.equal([parent]);
      expect(parent.children).to.deep.equal([child]);
      expect(child.parent).to.equal(parent);
      expect(parent.parent).to.equal(grandparent);

      // Moving child to grandparent should not cause validation loops
      // Even though validation might traverse the tree
      grandparent.children[1] = child;

      expect(grandparent.children).to.deep.equal([parent, child]);
      expect(parent.children).to.deep.equal([]);
      expect(child.parent).to.equal(grandparent);
    });

    it("should handle adoption order when child validates parent relationship", () => {
      const { site } = createTestSite("Parent Validation Test");
      const parent1 = new Component({ name: "Parent1", type: "container", children: [], metadata: {} });
      const parent2 = new Component({ name: "Parent2", type: "container", children: [], metadata: {} });
      const child = new Component({ name: "Child", type: "child", children: [], metadata: {} });

      site.components.parent1 = parent1;
      site.components.parent2 = parent2;

      parent1.children.push(child);
      expect(child.parent).to.equal(parent1);

      // Moving child to parent2 should:
      // 1. Orphanize from parent1
      // 2. Assign to parent2.children[0]
      // 3. THEN call requestAdoptionSymbol
      // If requestAdoptionSymbol is called before assignment,
      // validation might see child still in parent1.children
      parent2.children[0] = child;

      expect(parent1.children).to.deep.equal([]);
      expect(parent2.children).to.deep.equal([child]);
      expect(child.parent).to.equal(parent2);
    });

    it("should handle adoption order with observer/reactivity during assignment", () => {
      const { site } = createTestSite("Observer Order Test");
      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      site.components.parent = parent;

      const [a, b, c] = ["a", "b", "c"].map(
        (name) => new Component({ name, type: "child", children: [], metadata: {} }),
      );
      parent.children.push(a, b, c);

      // Track that we can read parent.children during the assignment
      // without hitting inconsistent state
      const observedDuringAssignment: Component[] | null = null;

      // Simulate observer/reaction that reads the array
      // This would be triggered by trackModification during assignment
      // If adoption happens before assignment, array might have duplicates
      const originalB = b;
      parent.children[1] = a; // Should remove a from 0, then set at 1

      // After assignment, should be consistent
      expect(parent.children).to.deep.equal([a, c]);

      // Verify no duplicates exist at any point
      const aCount = parent.children.filter((x) => x === a).length;
      expect(aCount).to.equal(1);

      // Verify b was properly orphanized
      expect(originalB.parent).to.eq(null);
    });
  });

  describe("State consistency on failed adoption", () => {
    // Tests that verify state isn't corrupted when adoption throws (cycle error)
    // This was a bug where orphaning/removal happened BEFORE validation

    it("push: should not remove reused elements when new element adoption fails", () => {
      @syncing("PushTreeNode")
      class PushTreeNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.list accessor children!: PushTreeNode[];
      }

      const grandchild = new PushTreeNode({ name: "grandchild", children: [] });
      const child = new PushTreeNode({ name: "child", children: [grandchild] });
      const rootNode = new PushTreeNode({ name: "root", children: [child] });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children[0];
      const grandchildNode = childNode.children[0];

      // Simplified: grandchild's array trying to push childNode (its ancestor)
      expect(() => {
        grandchildNode.children.push(childNode);
      }).to.throw(/would create cycle/i);

      // Hierarchy should be unchanged
      expect(childNode.parent).to.equal(root);
      expect(grandchildNode.parent).to.equal(childNode);
      expect(childNode.children[0]).to.equal(grandchildNode);
    });

    it("push: should preserve array state when pushing cycle-causing element with reused element", () => {
      @syncing("PushReuseTreeNode")
      class PushReuseTreeNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.list accessor children!: PushReuseTreeNode[];
      }

      // Build: root -> parent (has [item1, item2, item3])
      //                    -> child (empty, will try to push parent with reuse of item1)
      const item1 = new PushReuseTreeNode({ name: "item1", children: [] });
      const item2 = new PushReuseTreeNode({ name: "item2", children: [] });
      const item3 = new PushReuseTreeNode({ name: "item3", children: [] });
      const child = new PushReuseTreeNode({ name: "child", children: [] });
      const parent = new PushReuseTreeNode({ name: "parent", children: [item1, item2, item3, child] });
      const rootNode = new PushReuseTreeNode({ name: "root", children: [parent] });

      const { root } = initTestPlexus(rootNode);
      const parentNode = root.children[0];
      const childNode = parentNode.children[3];
      const item1Node = parentNode.children[0];
      const item2Node = parentNode.children[1];

      // child tries to push parent (its ancestor) - would create cycle
      expect(() => {
        childNode.children.push(parentNode);
      }).to.throw(/would create cycle/i);

      // All items should still be properly parented
      expect(item1Node.parent).to.equal(parentNode);
      expect(item2Node.parent).to.equal(parentNode);
      expect(childNode.parent).to.equal(parentNode);
      expect(parentNode.children).to.have.lengthOf(4);
    });

    it("unshift: should not corrupt array when adoption fails", () => {
      @syncing("UnshiftTreeNode")
      class UnshiftTreeNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.list accessor children!: UnshiftTreeNode[];
      }

      const grandchild = new UnshiftTreeNode({ name: "grandchild", children: [] });
      const child = new UnshiftTreeNode({ name: "child", children: [grandchild] });
      const rootNode = new UnshiftTreeNode({ name: "root", children: [child] });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children[0];
      const grandchildNode = childNode.children[0];

      // grandchild tries to unshift childNode (its ancestor)
      expect(() => {
        grandchildNode.children.unshift(childNode);
      }).to.throw(/would create cycle/i);

      // Hierarchy should be unchanged
      expect(childNode.parent).to.equal(root);
      expect(grandchildNode.parent).to.equal(childNode);
      expect(grandchildNode.children).to.have.lengthOf(0);
    });

    it("assign: should not orphan existing items when new items adoption fails", () => {
      @syncing("AssignTreeNode")
      class AssignTreeNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.list accessor children!: AssignTreeNode[];
      }

      // Create hierarchy: root -> child -> grandchild -> [item1, item2]
      const item1 = new AssignTreeNode({ name: "item1", children: [] });
      const item2 = new AssignTreeNode({ name: "item2", children: [] });
      const grandchild = new AssignTreeNode({ name: "grandchild", children: [item1, item2] });
      const child = new AssignTreeNode({ name: "child", children: [grandchild] });
      const rootNode = new AssignTreeNode({ name: "root", children: [child] });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children[0];
      const grandchildNode = childNode.children[0];
      const item1Node = grandchildNode.children[0];
      const item2Node = grandchildNode.children[1];
      const newItem = new AssignTreeNode({ name: "new", children: [] });

      // grandchild tries to assign array including child (its ancestor) - would create cycle
      expect(() => {
        grandchildNode.children = [newItem, childNode];
      }).to.throw(/would create cycle/i);

      // Original items should still be properly parented to grandchild
      expect(item1Node.parent).to.equal(grandchildNode);
      expect(item2Node.parent).to.equal(grandchildNode);
      expect(grandchildNode.children).to.have.ordered.members([item1Node, item2Node]);
      // newItem should not have been adopted
      expect(newItem.parent).to.eq(null);
      // childNode should still be parented to root
      expect(childNode.parent).to.equal(root);
    });

    it("index assignment: should not orphan existing item when replacement adoption fails", () => {
      @syncing("IndexTreeNode")
      class IndexTreeNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.list accessor children!: IndexTreeNode[];
      }

      const existingChild = new IndexTreeNode({ name: "existing", children: [] });
      const grandchild = new IndexTreeNode({ name: "grandchild", children: [existingChild] });
      const child = new IndexTreeNode({ name: "child", children: [grandchild] });
      const rootNode = new IndexTreeNode({ name: "root", children: [child] });

      const { root } = initTestPlexus(rootNode);
      const childNode = root.children[0];
      const grandchildNode = childNode.children[0];
      const existingNode = grandchildNode.children[0];

      // Try to replace existingChild with childNode (ancestor) - would create cycle
      expect(() => {
        grandchildNode.children[0] = childNode;
      }).to.throw(/would create cycle/i);

      // existingChild should still be in place
      expect(grandchildNode.children[0]).to.equal(existingNode);
      expect(existingNode.parent).to.equal(grandchildNode);
      expect(grandchildNode.parent).to.equal(childNode);
    });
  });
});
