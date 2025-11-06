/**
 * Simple tests for tuple-based reference format optimization
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { isTupleReference } from "../utils";

describe("Tuple Reference Format - Core Functionality", () => {
  it("should identify tuple references correctly", () => {
    // Valid tuple references
    expect(isTupleReference(["entity123"])).toBe(true);
    expect(isTupleReference(["entity123", "project456"])).toBe(true);

    // Invalid formats
    expect(isTupleReference([])).toBe(false);
    expect(isTupleReference(["entity", "project", "extra"])).toBe(false);
    expect(isTupleReference([123])).toBe(false);
    expect(isTupleReference({ __ref: "entity123" })).toBe(false);
    expect(isTupleReference("not-array")).toBe(false);
    expect(isTupleReference(null)).toBe(false);
  });

  it("should store tuple references efficiently in YJS", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("test");

    // Store tuple references in map
    map.set("localRef", ["entity123"]);
    map.set("crossRef", ["entity123", "project456"]);

    // Store array of tuple references using Y.Array.from
    const tupleRefs = [["entity789"], ["entity789", "project999"]];
    const array = Y.Array.from(tupleRefs);
    map.set("arrayRefs", array);

    // Verify storage
    expect(map.get("localRef")).toEqual(["entity123"]);
    expect(map.get("crossRef")).toEqual(["entity123", "project456"]);

    const storedArray = map.get("arrayRefs") as Y.Array<any>;
    expect(storedArray.get(0)).toEqual(["entity789"]);
    expect(storedArray.get(1)).toEqual(["entity789", "project999"]);
  });

  it("should demonstrate memory efficiency gains", () => {
    const legacyLocalRef = { __ref: "entity123" };
    const legacyCrossRef = { __xref: { iid: "entity123", uuid: "project456" } };
    const tupleLocalRef = ["entity123"];
    const tupleCrossRef = ["entity123", "project456"];

    // Compare JSON sizes
    const legacyLocalSize = JSON.stringify(legacyLocalRef).length;
    const legacyCrossSize = JSON.stringify(legacyCrossRef).length;
    const tupleLocalSize = JSON.stringify(tupleLocalRef).length;
    const tupleCrossSize = JSON.stringify(tupleCrossRef).length;

    console.log("Reference sizes:", {
      legacyLocal: legacyLocalSize,
      legacyCross: legacyCrossSize,
      tupleLocal: tupleLocalSize,
      tupleCross: tupleCrossSize,
      localSavings: `${Math.round((1 - tupleLocalSize / legacyLocalSize) * 100)}%`,
      crossSavings: `${Math.round((1 - tupleCrossSize / legacyCrossSize) * 100)}%`
    });

    // Tuple format should be more compact
    expect(tupleLocalSize).toBeLessThan(legacyLocalSize);
    expect(tupleCrossSize).toBeLessThan(legacyCrossSize);
  });

  it("should work with real YJS document synchronization", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Create data in doc1 with tuple references
    const models1 = doc1.getMap("models");
    models1.set("user.name", "Alice");
    models1.set("user.posts", Y.Array.from([["post1"], ["post2"]]));
    models1.set("post1.author", ["user"]);
    models1.set("post1.title", "Hello World");

    // Sync to doc2
    const update = Y.encodeStateAsUpdate(doc1);
    Y.applyUpdate(doc2, update);

    // Verify data arrived correctly
    const models2 = doc2.getMap("models");
    expect(models2.get("user.name")).toBe("Alice");

    const userPosts = models2.get("user.posts") as Y.Array<any>;
    expect(userPosts.get(0)).toEqual(["post1"]);
    expect(userPosts.get(1)).toEqual(["post2"]);

    expect(models2.get("post1.author")).toEqual(["user"]);
    expect(models2.get("post1.title")).toBe("Hello World");
  });

  it("should handle arrays of tuple references efficiently", () => {
    const doc = new Y.Doc();
    const models = doc.getMap("models");

    // Store array of tuple references (like a component's children)
    const children = Y.Array.from([["child1"], ["child2"], ["child3", "external-project"]]);

    models.set("component.children", children);

    // Verify retrieval
    const retrievedChildren = models.get("component.children") as Y.Array<any>;
    expect(retrievedChildren.length).toBe(3);
    expect(retrievedChildren.get(0)).toEqual(["child1"]);
    expect(retrievedChildren.get(1)).toEqual(["child2"]);
    expect(retrievedChildren.get(2)).toEqual(["child3", "external-project"]);
  });
});

// Export the helper for use in other tests
export { isTupleReference };
