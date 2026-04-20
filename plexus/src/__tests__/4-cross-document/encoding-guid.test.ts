/**
 * Doc-Independent UUID Tests
 *
 * CRDT-native UUIDs use a Feistel cipher with fixed round keys — no doc.guid
 * dependency. This means any Y.Doc can load serialized state and decode
 * UUIDs correctly regardless of its guid.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { Plexus } from "../../Plexus.js";
import { PlexusModel } from "../../PlexusModel.js";

@syncing("GuidTestNode")
class GuidTestNode extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.list
  accessor children!: GuidTestNode[];
}

@syncing("GuidTestRoot")
class GuidTestRoot extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing
  accessor tree!: GuidTestNode | null;
}

describe("Doc-Independent UUID Resolution", () => {
  it("should connect to serialized state on a doc with any guid", () => {
    const root = new GuidTestRoot({ title: "Test Project", tree: null });
    const plexus = Plexus.bootstrap(root, "original-guid");

    const child = new GuidTestNode({ name: "Child", children: [] });
    const grandchild = new GuidTestNode({ name: "Grandchild", children: [] });
    child.children.push(grandchild);
    root.tree = child;

    const rootUuid = root.uuid;
    const childUuid = child.uuid;
    const grandchildUuid = grandchild.uuid;

    // Serialize and load into a doc with a completely different guid
    const state = Y.encodeStateAsUpdate(plexus.doc);
    const newDoc = new Y.Doc({ guid: "totally-different" });
    Y.applyUpdate(newDoc, state);

    const reconnected = Plexus.connect(newDoc);
    const reconnectedRoot = reconnected.root as GuidTestRoot;

    expect(reconnectedRoot.uuid).toBe(rootUuid);
    expect(reconnectedRoot.title).toBe("Test Project");
    expect(reconnectedRoot.tree!.uuid).toBe(childUuid);
    expect(reconnectedRoot.tree!.name).toBe("Child");
    expect(reconnectedRoot.tree!.children).toHaveLength(1);
    expect(reconnectedRoot.tree!.children[0].uuid).toBe(grandchildUuid);
    expect(reconnectedRoot.tree!.children[0].name).toBe("Grandchild");
  });

  it("should allow mutations on a reconnected doc", () => {
    const root = new GuidTestRoot({ title: "Mutable", tree: null });
    const plexus = Plexus.bootstrap(root);
    root.tree = new GuidTestNode({ name: "Original", children: [] });

    const state = Y.encodeStateAsUpdate(plexus.doc);
    const newDoc = new Y.Doc();
    Y.applyUpdate(newDoc, state);
    const reconnected = Plexus.connect(newDoc);
    const reconnectedRoot = reconnected.root as GuidTestRoot;

    reconnectedRoot.title = "Modified";
    reconnectedRoot.tree!.name = "Renamed";

    const newChild = new GuidTestNode({ name: "NewChild", children: [] });
    reconnectedRoot.tree!.children.push(newChild);

    expect(newChild.uuid).toBeTruthy();
    expect(reconnectedRoot.tree!.children).toHaveLength(1);
    expect(reconnectedRoot.tree!.children[0].name).toBe("NewChild");
    expect(reconnectedRoot.tree!.children[0].uuid).toBe(newChild.uuid);
  });

  it("should sync between two peers with different guids", () => {
    const root = new GuidTestRoot({ title: "Syncable", tree: null });
    const plexus = Plexus.bootstrap(root);
    root.tree = new GuidTestNode({ name: "Root Node", children: [] });

    const state = Y.encodeStateAsUpdate(plexus.doc);

    // Two peers with completely different guids — doesn't matter anymore
    const peerDoc1 = new Y.Doc({ guid: "peer-1" });
    const peerDoc2 = new Y.Doc({ guid: "peer-2" });
    Y.applyUpdate(peerDoc1, state);
    Y.applyUpdate(peerDoc2, state);

    const peer1 = Plexus.connect(peerDoc1);
    const peer2 = Plexus.connect(peerDoc2);
    const root1 = peer1.root as GuidTestRoot;
    const root2 = peer2.root as GuidTestRoot;

    expect(root1.title).toBe("Syncable");
    expect(root2.title).toBe("Syncable");

    // Mutate on peer 1
    root1.tree!.children.push(new GuidTestNode({ name: "From Peer 1", children: [] }));

    // Sync peer1 → peer2
    const update1 = Y.encodeStateAsUpdateV2(peerDoc1, Y.encodeStateVector(peerDoc2));
    Y.applyUpdateV2(peerDoc2, update1);

    expect(root2.tree!.children).toHaveLength(1);
    expect(root2.tree!.children[0].name).toBe("From Peer 1");

    // Mutate on peer 2
    root2.title = "Synced!";

    // Sync peer2 → peer1
    const update2 = Y.encodeStateAsUpdateV2(peerDoc2, Y.encodeStateVector(peerDoc1));
    Y.applyUpdateV2(peerDoc1, update2);

    expect(root1.title).toBe("Synced!");
  });

  it("should survive multiple serialize/deserialize cycles", () => {
    const root = new GuidTestRoot({ title: "Durable", tree: null });
    const plexus = Plexus.bootstrap(root);
    root.tree = new GuidTestNode({ name: "Survives", children: [] });

    // Cycle through 3 different docs with 3 different guids
    const state1 = Y.encodeStateAsUpdate(plexus.doc);
    const doc2 = new Y.Doc({ guid: "cycle-2" });
    Y.applyUpdate(doc2, state1);

    const state2 = Y.encodeStateAsUpdate(doc2);
    const doc3 = new Y.Doc({ guid: "cycle-3" });
    Y.applyUpdate(doc3, state2);

    const reconnected = Plexus.connect(doc3);
    const reconnectedRoot = reconnected.root as GuidTestRoot;
    expect(reconnectedRoot.title).toBe("Durable");
    expect(reconnectedRoot.tree!.name).toBe("Survives");
  });
});
