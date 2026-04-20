/**
 * Type Index Tests
 *
 * Tests for the type-level instance index that enables
 * getAllOfType queries without full document traversal.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Alpha")
class Alpha extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("Beta")
class Beta extends PlexusModel {
  @syncing accessor value: number = 0;
}

@syncing("TypeIndexRoot")
class TypeIndexRoot extends PlexusModel<null> {
  @syncing.child.list accessor alphas: Alpha[] = [];
  @syncing.child.list accessor betas: Beta[] = [];
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
}

describe("Type Index", () => {
  it("returns empty for unknown type", () => {
    const { plexus } = initTestPlexus(new TypeIndexRoot());
    expect(plexus.getAllOfType(Alpha)).toEqual([]);
    expect(plexus.getAllOfType(Beta)).toEqual([]);
  });

  it("returns materialized instances", () => {
    const { plexus, root } = initTestPlexus(new TypeIndexRoot());
    const a1 = new Alpha({ name: "first" });
    const a2 = new Alpha({ name: "second" });
    root.alphas.push(a1, a2);

    const result = plexus.getAllOfType(Alpha);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((a) => a.name))).toEqual(new Set(["first", "second"]));
  });

  it("discriminates by type", () => {
    const { plexus, root } = initTestPlexus(new TypeIndexRoot());
    root.alphas.push(new Alpha({ name: "a" }));
    root.betas.push(new Beta({ value: 42 }));

    expect(plexus.getAllOfType(Alpha)).toHaveLength(1);
    expect(plexus.getAllOfType(Alpha)[0].name).toBe("a");

    expect(plexus.getAllOfType(Beta)).toHaveLength(1);
    expect(plexus.getAllOfType(Beta)[0].value).toBe(42);
  });

  it("does not include ephemeral (unmaterialized) models", () => {
    const { plexus } = initTestPlexus(new TypeIndexRoot());
    // Create but don't attach to tree
    new Alpha({ name: "ghost" });

    expect(plexus.getAllOfType(Alpha)).toEqual([]);
  });

  it("syncs type index across documents", () => {
    const { plexus: plexus1, root, doc: doc1 } = initTestPlexus(new TypeIndexRoot());
    root.alphas.push(new Alpha({ name: "from-doc1" }));

    const doc2 = new Y.Doc({ guid: doc1.guid });
    syncDocs(doc1, doc2);

    const { plexus: plexus2 } = connectTestPlexus<TypeIndexRoot>(doc2);
    const remoteAlphas = plexus2.getAllOfType(Alpha);
    expect(remoteAlphas).toHaveLength(1);
    expect(remoteAlphas[0].name).toBe("from-doc1");
  });

  it("includes root in type index", () => {
    const { plexus } = initTestPlexus(new TypeIndexRoot());
    const roots = plexus.getAllOfType(TypeIndexRoot);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(plexus.root);
  });
});
