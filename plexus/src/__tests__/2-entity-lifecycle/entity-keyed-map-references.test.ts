/**
 * Verification tests for the ref-wiring spec
 * (docs/proposals/in-flight/ref-wiring-via-componentdataquery.md).
 *
 * The spec adds a single field to ComponentDataQuery:
 *   @syncing.map accessor nodeRefs!: Map<ModelConsumedSlot | ModelProvidedSlot, TplNode | null>
 *
 * These tests pin the load-bearing assumptions about how Plexus handles
 * a `@syncing.map` whose KEY is an entity and whose VALUE is a (nullable)
 * entity reference. Standing in:
 *   Slot   ⇢ ModelConsumedSlot | ModelProvidedSlot
 *   Node   ⇢ TplNode
 *   Query  ⇢ ComponentDataQuery
 *
 * What we want to be sure of, and why each one matters for the spec:
 *
 *   A. `@syncing.map` accepts entity keys + nullable entity values
 *      → that's the literal field type the spec writes down.
 *
 *   B. parentsOf(node, Query, "nodeRefs") finds queries that reference
 *      `node` as a VALUE (the Plexus.ts `case "map"` only iterates
 *      `.values()`, so this is supposed to work — pin it).
 *
 *   C. parentsOf does NOT find queries that hold an entity as a KEY.
 *      This is the negative-space half of B. It tells the spec that
 *      "find queries by slot" CANNOT use parentsOf — it must use
 *      getAllOfType(Query) and probe `.has(slot)` per query. The
 *      spec calls this out (V2 / V3); these tests confirm the
 *      upstream restriction it's reacting to.
 *
 *   D. The `getAllOfType(Query)` + `q.nodeRefs.has(slot)` workaround
 *      from C actually works — including detecting deletion of a
 *      slot leaving dangling key references.
 *
 *   E. Null values are first-class (they encode "wired but unbound").
 *
 *   F. Detached value entities (Plexus uses append-only shells —
 *      undoing or removing from owner doesn't dematerialize) remain
 *      readable. Spec L1 ("Reads MAY return a detached TplNode
 *      reference; consumers null-check") rests on this.
 *
 *   G. A wired `@syncing.map` does NOT auto-orphan its values
 *      (orphan cleanup runs only when `isChildField`). Spec must
 *      handle stale-ref cleanup itself.
 *
 *   H. CRDT convergence: two replicas writing the same
 *      (entity-key → entity-value) entry resolve to one canonical
 *      value (Y.Map LWW per key); replicas writing distinct keys
 *      converge to the union.
 *
 * If any of these tests fail, the spec needs a revision before the
 * PR-A change to `ComponentDataQuery` lands.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// ── Stand-in entities ─────────────────────────────────────────────────

@syncing("Slot")
class Slot extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("Node")
class Node extends PlexusModel {
  @syncing accessor label: string = "";
}

@syncing("Query")
class Query extends PlexusModel {
  @syncing accessor name: string = "";
  /**
   * Mirror of the spec's nodeRefs field.
   * Reference-only (NOT child) — slots and nodes have their own owners.
   */
  @syncing.map accessor nodeRefs!: Map<Slot, Node | null>;
}

@syncing("Root")
class Root extends PlexusModel<null> {
  @syncing.child.list accessor slots: Slot[] = [];
  @syncing.child.list accessor nodes: Node[] = [];
  @syncing.child.list accessor queries: Query[] = [];
}

// ── Helpers ───────────────────────────────────────────────────────────

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

// ─────────────────────────────────────────────────────────────────────
// A. Field shape: entity-keyed, nullable-valued map
// ─────────────────────────────────────────────────────────────────────

describe("A. @syncing.map<Slot, Node | null>", () => {
  it("accepts entity-key → entity-value entries", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "viewport" });
    const node = new Node({ label: "div#1" });
    const query = new Query({ name: "embla", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    expect(query.nodeRefs.get(slot)).toBe(node);
    expect(query.nodeRefs.has(slot)).toBe(true);
    expect(query.nodeRefs.size).toBe(1);
  });

  it("accepts entity-key → null (wired-but-unbound)", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "viewport" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, null]]) });
    root.slots.push(slot);
    root.queries.push(query);

    expect(query.nodeRefs.has(slot)).toBe(true);
    expect(query.nodeRefs.get(slot)).toBe(null);
  });

  it("supports multiple entries (multi-ref hooks like useFloating)", () => {
    const { root } = initTestPlexus(new Root());
    const ref = new Slot({ name: "reference" });
    const flo = new Slot({ name: "floating" });
    const anchor = new Node({ label: "button" });
    const popover = new Node({ label: "div#popover" });
    const query = new Query({
      name: "tooltip",
      nodeRefs: new Map<Slot, Node | null>([
        [ref, anchor],
        [flo, popover],
      ]),
    });
    root.slots.push(ref, flo);
    root.nodes.push(anchor, popover);
    root.queries.push(query);

    expect(query.nodeRefs.size).toBe(2);
    expect(query.nodeRefs.get(ref)).toBe(anchor);
    expect(query.nodeRefs.get(flo)).toBe(popover);
  });

  it("set/delete/clear work after creation", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "viewport" });
    const node = new Node({ label: "div#1" });
    const query = new Query({ name: "q", nodeRefs: new Map() });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    query.nodeRefs.set(slot, node);
    expect(query.nodeRefs.get(slot)).toBe(node);

    query.nodeRefs.set(slot, null);
    expect(query.nodeRefs.get(slot)).toBe(null);
    expect(query.nodeRefs.has(slot)).toBe(true);

    query.nodeRefs.delete(slot);
    expect(query.nodeRefs.has(slot)).toBe(false);
    expect(query.nodeRefs.size).toBe(0);

    query.nodeRefs.set(slot, node);
    query.nodeRefs.clear();
    expect(query.nodeRefs.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// B. parentsOf finds owners by VALUE
// ─────────────────────────────────────────────────────────────────────

describe("B. parentsOf(node, Query, 'nodeRefs') — by value", () => {
  it("returns query when node is a value in nodeRefs", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    expect([...plexus.parentsOf(node, Query, "nodeRefs")]).toEqual([query]);
  });

  it("returns multiple queries when node is wired into many", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const sA = new Slot({ name: "a" });
    const sB = new Slot({ name: "b" });
    const node = new Node({ label: "shared" });
    const q1 = new Query({ name: "q1", nodeRefs: new Map([[sA, node]]) });
    const q2 = new Query({ name: "q2", nodeRefs: new Map([[sB, node]]) });
    root.slots.push(sA, sB);
    root.nodes.push(node);
    root.queries.push(q1, q2);

    const found = new Set(plexus.parentsOf(node, Query, "nodeRefs"));
    expect(found).toEqual(new Set([q1, q2]));
  });

  it("dedups when same query references node from multiple keys", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const sA = new Slot({ name: "a" });
    const sB = new Slot({ name: "b" });
    const node = new Node({ label: "shared" });
    const query = new Query({
      name: "q",
      nodeRefs: new Map<Slot, Node | null>([
        [sA, node],
        [sB, node],
      ]),
    });
    root.slots.push(sA, sB);
    root.nodes.push(node);
    root.queries.push(query);

    expect([...plexus.parentsOf(node, Query, "nodeRefs")]).toEqual([query]);
  });

  it("does not return queries where the value is null", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, null]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    expect([...plexus.parentsOf(node, Query, "nodeRefs")]).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// C. parentsOf does NOT find owners by KEY
// ─────────────────────────────────────────────────────────────────────

describe("C. parentsOf does not match keys", () => {
  it("calling parentsOf with a slot returns no queries even when it's a key", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "viewport" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    // Confirms Plexus.ts case "map" iterates only `.values()`.
    // The spec must not rely on parentsOf for key-side lookups.
    expect([...plexus.parentsOf(slot, Query, "nodeRefs")]).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// D. getAllOfType + .has(slot) is the working alternative for keys
// ─────────────────────────────────────────────────────────────────────

describe("D. getAllOfType(Query) + .nodeRefs.has(slot)", () => {
  it("finds queries that hold a given slot as key", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const sX = new Slot({ name: "x" });
    const sY = new Slot({ name: "y" });
    const node = new Node({ label: "n" });
    const q1 = new Query({ name: "q1", nodeRefs: new Map([[sX, node]]) });
    const q2 = new Query({ name: "q2", nodeRefs: new Map([[sY, node]]) });
    const q3 = new Query({ name: "q3", nodeRefs: new Map([[sX, null]]) });
    root.slots.push(sX, sY);
    root.nodes.push(node);
    root.queries.push(q1, q2, q3);

    const queriesWithSX = [...plexus.getAllOfType(Query)].filter((q) => q.nodeRefs.has(sX));
    expect(new Set(queriesWithSX)).toEqual(new Set([q1, q3]));
  });

  it("scales linearly across many queries (sanity, not perf)", () => {
    const { plexus, root } = initTestPlexus(new Root());
    const sTarget = new Slot({ name: "target" });
    const sOther = new Slot({ name: "other" });
    root.slots.push(sTarget, sOther);

    const expected: Query[] = [];
    for (let i = 0; i < 30; i++) {
      const node = new Node({ label: `n${i}` });
      root.nodes.push(node);
      const usesTarget = i % 3 === 0;
      const q = new Query({
        name: `q${i}`,
        nodeRefs: new Map([[usesTarget ? sTarget : sOther, node]]),
      });
      root.queries.push(q);
      if (usesTarget) expected.push(q);
    }

    const found = [...plexus.getAllOfType(Query)].filter((q) => q.nodeRefs.has(sTarget));
    expect(new Set(found)).toEqual(new Set(expected));
    expect(found.length).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────
// E. Null values are first-class
// ─────────────────────────────────────────────────────────────────────

describe("E. null as wired-but-unbound state", () => {
  it("has(slot) is true even when value is null", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, null]]) });
    root.slots.push(slot);
    root.queries.push(query);

    expect(query.nodeRefs.has(slot)).toBe(true);
    expect(query.nodeRefs.get(slot)).toBe(null);
  });

  it("transitions null → node → null cleanly", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, null]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    query.nodeRefs.set(slot, node);
    expect(query.nodeRefs.get(slot)).toBe(node);
    query.nodeRefs.set(slot, null);
    expect(query.nodeRefs.get(slot)).toBe(null);
    expect(query.nodeRefs.has(slot)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// F. Detached value entities (append-only shells)
// ─────────────────────────────────────────────────────────────────────

describe("F. detached node values stay readable (append-only shells)", () => {
  it("reading nodeRefs after node is removed from owner yields the same Node entity (still readable)", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "lives-on" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    // Detach node from its owner. Plexus uses append-only shells —
    // the entity instance survives, just no longer owned by the tree.
    const idx = root.nodes.indexOf(node);
    root.nodes.splice(idx, 1);

    // The ref entry remains, and reading the Node still returns
    // the same instance with its creation-time fields readable.
    expect(query.nodeRefs.has(slot)).toBe(true);
    const stillThere = query.nodeRefs.get(slot);
    expect(stillThere).toBe(node);
    expect(stillThere?.label).toBe("lives-on");
    // It IS detached from owner-tree, however:
    expect(root.nodes.includes(node)).toBe(false);
  });

  it("removed node still appears under parentsOf (entry not auto-cleaned)", () => {
    // This pins assumption G as well — a `@syncing.map` (NOT child)
    // never garbage-collects entries when the value is detached.
    const { plexus, root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    root.nodes.splice(root.nodes.indexOf(node), 1);

    // Stale ref still points back to query. The spec must do its own
    // sweep (validation pass) — Plexus will not clean this up.
    expect([...plexus.parentsOf(node, Query, "nodeRefs")]).toEqual([query]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// G. No auto-orphan on @syncing.map (proves we need explicit cleanup)
// ─────────────────────────────────────────────────────────────────────

describe("G. @syncing.map (reference field) does not orphan values", () => {
  it("removing the query does not affect the node (ownership is one-way)", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    root.queries.splice(root.queries.indexOf(query), 1);

    // Node was a reference, not a child — it's untouched.
    expect(root.nodes.includes(node)).toBe(true);
    expect(node.label).toBe("n");
  });

  it("removing the node leaves the query.nodeRefs entry intact (no auto-cleanup)", () => {
    const { root } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    root.slots.push(slot);
    root.nodes.push(node);
    root.queries.push(query);

    root.nodes.splice(root.nodes.indexOf(node), 1);

    // Entry is NOT removed; this is why spec needs a validation sweep.
    expect(query.nodeRefs.has(slot)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// H. CRDT convergence
// ─────────────────────────────────────────────────────────────────────

describe("H. cross-doc convergence", () => {
  it("two replicas writing distinct keys converge to the union", () => {
    const { doc: docA, root: rootA } = initTestPlexus(new Root());
    const sA = new Slot({ name: "a" });
    const sB = new Slot({ name: "b" });
    const nA = new Node({ label: "nA" });
    const nB = new Node({ label: "nB" });
    const query = new Query({ name: "q", nodeRefs: new Map() });
    rootA.slots.push(sA, sB);
    rootA.nodes.push(nA, nB);
    rootA.queries.push(query);

    // Initialise replica B from A
    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<Root>(docB);
    const queryB = rootB.queries[0];

    // Concurrent writes to distinct keys
    query.nodeRefs.set(sA, nA);
    queryB.nodeRefs.set(rootB.slots[1], rootB.nodes[1]);

    syncDocs(docA, docB);

    expect(query.nodeRefs.size).toBe(2);
    expect(queryB.nodeRefs.size).toBe(2);
    expect(query.nodeRefs.has(sA)).toBe(true);
    expect(query.nodeRefs.has(sB)).toBe(true);
  });

  it("two replicas writing the same key converge (Y.Map LWW per key)", () => {
    const { doc: docA, root: rootA } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const nA = new Node({ label: "nA" });
    const nB = new Node({ label: "nB" });
    const query = new Query({ name: "q", nodeRefs: new Map() });
    rootA.slots.push(slot);
    rootA.nodes.push(nA, nB);
    rootA.queries.push(query);

    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<Root>(docB);
    const queryB = rootB.queries[0];
    const slotB = rootB.slots[0];

    // Concurrent writes to the SAME key with different values
    query.nodeRefs.set(slot, nA);
    queryB.nodeRefs.set(slotB, rootB.nodes[1]);

    syncDocs(docA, docB);

    // Both replicas converge to one value (LWW per key).
    // We don't pin which side wins — only that they agree.
    const valA = query.nodeRefs.get(slot);
    const valB = queryB.nodeRefs.get(slotB);
    expect(valA).toBeTruthy();
    expect(valB).toBeTruthy();
    expect(valA?.label).toBe(valB?.label);
    expect(query.nodeRefs.size).toBe(1);
    expect(queryB.nodeRefs.size).toBe(1);
  });

  it("delete vs set on same key converges (one wins, no half-state)", () => {
    const { doc: docA, root: rootA } = initTestPlexus(new Root());
    const slot = new Slot({ name: "s" });
    const node = new Node({ label: "n" });
    const query = new Query({ name: "q", nodeRefs: new Map([[slot, node]]) });
    rootA.slots.push(slot);
    rootA.nodes.push(node);
    rootA.queries.push(query);

    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<Root>(docB);
    const queryB = rootB.queries[0];
    const slotB = rootB.slots[0];

    // Concurrent: A keeps the entry (no-op-like reset); B deletes it.
    query.nodeRefs.set(slot, node);
    queryB.nodeRefs.delete(slotB);

    syncDocs(docA, docB);

    // Both sides agree on either-present-or-absent — never split.
    expect(query.nodeRefs.has(slot)).toBe(queryB.nodeRefs.has(slotB));
  });
});
