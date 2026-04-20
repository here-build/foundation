/**
 * parentsOf Tests
 *
 * Reverse-edge queries: given a node, find all instances of a parent class
 * whose specific field contains that node. Child fields early-return (ownership
 * exclusive). Reference fields yield all matches with dedup.
 */

import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ── Shared leaf ──

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

// ── Child field owners ──

@syncing("ChildValOwner")
class ChildValOwner extends PlexusModel {
  @syncing.child accessor item: Item | null = null;
}

@syncing("ChildListOwner")
class ChildListOwner extends PlexusModel {
  @syncing.child.list accessor items: Item[] = [];
}

@syncing("ChildSetOwner")
class ChildSetOwner extends PlexusModel {
  @syncing.child.set accessor items: Set<Item> = new Set();
}

@syncing("ChildRecordOwner")
class ChildRecordOwner extends PlexusModel {
  @syncing.child.record accessor items: Record<string, Item> = {};
}

@syncing("ChildMapOwner")
class ChildMapOwner extends PlexusModel {
  @syncing.child.map accessor items!: Map<string, Item>;
}

// ── Reference field owners ──

@syncing("RefValOwner")
class RefValOwner extends PlexusModel {
  @syncing accessor ref: Item | null = null;
}

@syncing("RefListOwner")
class RefListOwner extends PlexusModel {
  @syncing.list accessor refs: Item[] = [];
}

@syncing("RefSetOwner")
class RefSetOwner extends PlexusModel {
  @syncing.set accessor refs: Set<Item> = new Set();
}

@syncing("RefRecordOwner")
class RefRecordOwner extends PlexusModel {
  @syncing.record accessor refs: Record<string, Item> = {};
}

@syncing("RefMapOwner")
class RefMapOwner extends PlexusModel {
  @syncing.map accessor refs!: Map<string, Item>;
}

// ── Root ──

@syncing("Root")
class Root extends PlexusModel<null> {
  @syncing.child.list accessor childVals: ChildValOwner[] = [];
  @syncing.child.list accessor childLists: ChildListOwner[] = [];
  @syncing.child.list accessor childSets: ChildSetOwner[] = [];
  @syncing.child.list accessor childRecords: ChildRecordOwner[] = [];
  @syncing.child.list accessor childMaps: ChildMapOwner[] = [];
  @syncing.child.list accessor refVals: RefValOwner[] = [];
  @syncing.child.list accessor refLists: RefListOwner[] = [];
  @syncing.child.list accessor refSets: RefSetOwner[] = [];
  @syncing.child.list accessor refRecords: RefRecordOwner[] = [];
  @syncing.child.list accessor refMaps: RefMapOwner[] = [];
  @syncing.child.list accessor items: Item[] = [];
}

// ── Child field tests ──

describe("parentsOf — child fields", () => {
  it("child-val", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    const owner = new ChildValOwner({ item });
    root.childVals.push(owner);

    expect([...plexus.parentsOf(item, ChildValOwner, "item")]).toEqual([owner]);
  });

  it("child-list", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    const owner = new ChildListOwner({ items: [item] });
    root.childLists.push(owner);

    expect([...plexus.parentsOf(item, ChildListOwner, "items")]).toEqual([owner]);
  });

  it("child-set", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    const owner = new ChildSetOwner({ items: new Set([item]) });
    root.childSets.push(owner);

    expect([...plexus.parentsOf(item, ChildSetOwner, "items")]).toEqual([owner]);
  });

  it("child-record", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    const owner = new ChildRecordOwner({ items: { k: item } });
    root.childRecords.push(owner);

    expect([...plexus.parentsOf(item, ChildRecordOwner, "items")]).toEqual([owner]);
  });

  it("child-map", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    const owner = new ChildMapOwner({ items: new Map([["k", item]]) });
    root.childMaps.push(owner);

    expect([...plexus.parentsOf(item, ChildMapOwner, "items")]).toEqual([owner]);
  });

  it("early-returns after first match (ownership exclusive)", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    const owner = new ChildValOwner({ item });
    // second owner with a different item
    const other = new ChildValOwner({ item: new Item({ name: "other" }) });
    root.childVals.push(owner, other);

    const results = [...plexus.parentsOf(item, ChildValOwner, "item")];
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(owner);
  });

  it("empty collection does not yield", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new ChildListOwner({ items: [] });
    root.childLists.push(owner);

    expect([...plexus.parentsOf(item, ChildListOwner, "items")]).toEqual([]);
  });
});

// ── Reference field tests ──

describe("parentsOf — reference fields", () => {
  it("val reference", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new RefValOwner({ ref: item });
    root.refVals.push(owner);

    expect([...plexus.parentsOf(item, RefValOwner, "ref")]).toEqual([owner]);
  });

  it("list reference", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new RefListOwner({ refs: [item] });
    root.refLists.push(owner);

    expect([...plexus.parentsOf(item, RefListOwner, "refs")]).toEqual([owner]);
  });

  it("set reference", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new RefSetOwner({ refs: new Set([item]) });
    root.refSets.push(owner);

    expect([...plexus.parentsOf(item, RefSetOwner, "refs")]).toEqual([owner]);
  });

  it("record reference", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new RefRecordOwner({ refs: { k: item } });
    root.refRecords.push(owner);

    expect([...plexus.parentsOf(item, RefRecordOwner, "refs")]).toEqual([owner]);
  });

  it("map reference", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new RefMapOwner({ refs: new Map([["k", item]]) });
    root.refMaps.push(owner);

    expect([...plexus.parentsOf(item, RefMapOwner, "refs")]).toEqual([owner]);
  });

  it("multiple parents referencing same node", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "shared" });
    root.items.push(item);
    const a = new RefValOwner({ ref: item });
    const b = new RefValOwner({ ref: item });
    const c = new RefValOwner({ ref: new Item({ name: "other" }) });
    root.items.push(c.ref!);
    root.refVals.push(a, b, c);

    const results = [...plexus.parentsOf(item, RefValOwner, "ref")];
    expect(results).toHaveLength(2);
    expect(new Set(results)).toEqual(new Set([a, b]));
  });

  it("empty collection does not yield", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });
    root.items.push(item);
    const owner = new RefListOwner({ refs: [] });
    root.refLists.push(owner);

    expect([...plexus.parentsOf(item, RefListOwner, "refs")]).toEqual([]);
  });
});

// ── Error cases ──

describe("parentsOf — errors", () => {
  it("throws on nonexistent field", () => {
    const { plexus } = initTestPlexus(new Root());
    const item = new Item({ name: "target" });

    expect(() => [...plexus.parentsOf(item, Item, "bogus")]).toThrow(/does not exist/);
  });
});
