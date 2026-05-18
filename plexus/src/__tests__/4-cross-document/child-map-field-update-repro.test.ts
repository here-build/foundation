/**
 * Repro for an asymmetry hit while wiring a content-addressed result
 * store on top of `@syncing.child.map`:
 *
 *   1. Side A bootstraps a Root with `@syncing.child.map cells`.
 *   2. Side A *locally constructs* a Cell with props and `.set()`s it
 *      into root.cells at a key.
 *   3. Docs sync. Side B connects, reads the cell — its initial fields
 *      are visible.
 *   4. Side B mutates one of the cell's `@syncing accessor` fields.
 *   5. Docs sync.
 *   6. Side A reads the cell's field — and gets the **stale** initial
 *      value, even though Y bytes on doc1 grew by the same delta as on
 *      doc2 (the update is in the Y data on side A, just not reflected
 *      through Side A's locally-constructed JS instance).
 *
 * Sibling concern visible in `sync.test.ts:124` (the `//fail` comment
 * on Record fields being wiped after attach) suggests the same family
 * of bug: locally-constructed-then-attached entities don't fully bind
 * to the doc the way sync-materialized ones do.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("ChildMapBugCell")
class Cell extends PlexusModel {
  @syncing accessor specJson: string = "";
  @syncing accessor resultJson: string | null = null;
}

@syncing("ChildMapBugRoot")
class Root extends PlexusModel {
  @syncing.child.map accessor cells!: Map<string, Cell>;
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc): void {
  const u1 = Y.encodeStateAsUpdate(doc1);
  const u2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, u1);
  Y.applyUpdate(doc1, u2);
}

describe("@syncing.child.map: locally-constructed child + cross-doc field update", () => {
  it("propagates a field write on the synced side back through the locally-constructed JS instance", () => {
    // Side A: bootstrap, locally construct a child, attach it.
    const { doc: doc1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));
    const cellA = new Cell({ specJson: "spec-payload" });
    rootA.cells.set("k1", cellA);

    // Sanity: A sees its own writes.
    expect(rootA.cells.get("k1")).toBe(cellA);
    expect(cellA.specJson).toBe("spec-payload");
    expect(cellA.resultJson).toBe(null);

    // Side B: same-guid doc, sync, connect.
    const doc2 = new Y.Doc({ guid: doc1.guid });
    syncDocs(doc1, doc2);
    const { root: rootB } = connectTestPlexus<Root>(doc2);

    const cellB = rootB.cells.get("k1");
    expect(cellB).toBeDefined();
    expect(cellB!.specJson).toBe("spec-payload");
    expect(cellB!.resultJson).toBe(null);

    // Side B: write the previously-unset field.
    cellB!.resultJson = "answered-from-B";
    expect(cellB!.resultJson).toBe("answered-from-B");

    // Bidirectional sync.
    const s1Before = Y.encodeStateAsUpdate(doc1).byteLength;
    syncDocs(doc1, doc2);
    const s1After = Y.encodeStateAsUpdate(doc1).byteLength;

    // Y data on side A grew (proving sync at Y level — B's field-write
    // delta is now in doc1). Side A locally has everything Side B does.
    expect(s1After).toBeGreaterThan(s1Before);

    // Side A: the locally-constructed JS instance should reflect Side B's write.
    expect(cellA.resultJson).toBe("answered-from-B");
  });

  it("variant — write wrapped in plexus.transact()", () => {
    // Same as the first test but every write goes through plexus.transact().
    // Isolates whether transact wrapping breaks the propagation.
    const { doc: doc1, plexus: plexus1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));

    plexus1.transact(() => {
      const cell = new Cell({ specJson: "spec-payload" });
      rootA.cells.set("k1", cell);
    });
    const cellA = rootA.cells.get("k1")!;
    expect(cellA.specJson).toBe("spec-payload");

    const doc2 = new Y.Doc({ guid: doc1.guid });
    syncDocs(doc1, doc2);
    const { plexus: plexus2, root: rootB } = connectTestPlexus<Root>(doc2);
    const cellB = rootB.cells.get("k1")!;

    plexus2.transact(() => {
      cellB.resultJson = "answered-from-B";
    });

    syncDocs(doc1, doc2);

    expect(cellA.resultJson).toBe("answered-from-B");
  });

  it("control case — both sides connect (neither side locally constructs the child) — propagates correctly", () => {
    // Bootstrap an empty root on doc1. Side B connects to same-guid doc2.
    // Now we use side B (connect-side) to construct the child. Both sides
    // then see the entity as sync-materialized rather than locally-constructed
    // on one side. This isolates whether the asymmetry is about who created
    // the entity or about cross-doc field updates in general.
    const { doc: doc1, root: rootA } = initTestPlexus<Root>(new Root({ cells: new Map() }));
    const doc2 = new Y.Doc({ guid: doc1.guid });
    syncDocs(doc1, doc2);
    const { root: rootB } = connectTestPlexus<Root>(doc2);

    // Side B constructs and attaches.
    const cellB = new Cell({ specJson: "spec-payload" });
    rootB.cells.set("k1", cellB);

    syncDocs(doc1, doc2);

    // Side A now has a sync-materialized cell. Side A modifies a field.
    const cellA = rootA.cells.get("k1")!;
    expect(cellA).toBeDefined();
    expect(cellA.specJson).toBe("spec-payload");
    cellA.resultJson = "answered-from-A";

    syncDocs(doc1, doc2);

    // The locally-constructed-on-B instance — does it see A's write?
    expect(cellB.resultJson).toBe("answered-from-A");
  });
});
