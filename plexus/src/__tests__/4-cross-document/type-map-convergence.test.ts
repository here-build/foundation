/**
 * Genesis scaffold convergence tests.
 *
 * Verifies that declareDeterministicMap produces identical Yjs Items across
 * independent clients, so concurrent bootstrap + sync preserves all entities
 * instead of triggering Y.Map LWW conflict.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { genesisClientId, declareDeterministicMap } from "../../genesis-client.js";

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

describe("genesis clientId — CREATE2-style deterministic scaffold", () => {
  it("produces deterministic clientIds above uint32 range", () => {
    const id1 = genesisClientId("map", ["types", "SubModel"]);
    const id2 = genesisClientId("map", ["types", "SubModel"]);
    const id3 = genesisClientId("map", ["types", "Component"]);

    // Same input → same output
    expect(id1).toBe(id2);
    // Different input → different output
    expect(id1).not.toBe(id3);
    // Above uint32 range (structurally impossible to collide with Yjs clientIds)
    expect(id1).toBeGreaterThan(0xff_ff_ff_ff);
    expect(id3).toBeGreaterThan(0xff_ff_ff_ff);
    // Under MAX_SAFE_INTEGER
    expect(id1).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(id3).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it("two independent clients produce identical Items — sync is a no-op, all entities survive", () => {
    const guid = "genesis-test";

    const doc1 = new Y.Doc({ guid });
    const subModelA = declareDeterministicMap<Y.Map<string>>(doc1, ["types", "SubModel"]);
    subModelA.set("uuid-a1", new Y.Map<string>());
    subModelA.set("uuid-a2", new Y.Map<string>());

    const doc2 = new Y.Doc({ guid });
    const subModelB = declareDeterministicMap<Y.Map<string>>(doc2, ["types", "SubModel"]);
    subModelB.set("uuid-b1", new Y.Map<string>());
    subModelB.set("uuid-b2", new Y.Map<string>());

    expect([...subModelA.keys()].sort()).toEqual(["uuid-a1", "uuid-a2"]);
    expect([...subModelB.keys()].sort()).toEqual(["uuid-b1", "uuid-b2"]);

    syncDocs(doc1, doc2);

    const mergedA = [...subModelA.keys()].sort();
    const mergedB = [...subModelB.keys()].sort();
    expect(mergedA).toEqual(mergedB);
    expect(mergedA).toEqual(["uuid-a1", "uuid-a2", "uuid-b1", "uuid-b2"]);
  });

  it("multiple type maps all survive across independent clients", () => {
    const guid = "genesis-multi-type";
    const doc1 = new Y.Doc({ guid });
    const doc2 = new Y.Doc({ guid });

    const comp1 = declareDeterministicMap(doc1, ["types", "Component"]);
    const tpl1 = declareDeterministicMap(doc1, ["types", "TplTag"]);
    declareDeterministicMap(doc1, ["types", "Variant"]);

    const comp2 = declareDeterministicMap(doc2, ["types", "Component"]);
    declareDeterministicMap(doc2, ["types", "TplTag"]);
    const var2 = declareDeterministicMap(doc2, ["types", "Variant"]);

    comp1.set("comp-a", new Y.Map<string>());
    tpl1.set("tpl-a", new Y.Map<string>());
    comp2.set("comp-b", new Y.Map<string>());
    var2.set("var-b", new Y.Map<string>());

    syncDocs(doc1, doc2);

    expect([...comp1.keys()].sort()).toEqual(["comp-a", "comp-b"]);
    expect([...tpl1.keys()].sort()).toEqual(["tpl-a"]);
    expect([...declareDeterministicMap(doc1, ["types", "Variant"]).keys()].sort()).toEqual(["var-b"]);
    expect([...comp2.keys()].sort()).toEqual(["comp-a", "comp-b"]);
  });

  it("idempotent — calling declareDeterministicMap twice returns the same map", () => {
    const doc = new Y.Doc();
    const map1 = declareDeterministicMap(doc, ["types", "Foo"]);
    map1.set("x", "hello");
    const map2 = declareDeterministicMap(doc, ["types", "Foo"]);
    expect(map1).toBe(map2);
    expect(map2.get("x")).toBe("hello");
  });
});
