/**
 * UUID stability through undo/redo cycles.
 *
 * With append-only entity shells (deleteFilter protects typeMap entries),
 * entities survive undo — only their content and parent wiring are reverted.
 * UUID identity is always stable.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { getInternals, PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("UUIDRoot")
class Root extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor child: Child | null = null;
  @syncing.child.list accessor children: Child[] = [];
}

@syncing("UUIDChild")
class Child extends PlexusModel {
  @syncing accessor label: string = "";
  @syncing.child accessor nested: Child | null = null;
}

describe("UUID stability through undo/redo", () => {
  let plexus: TestPlexus<Root>;
  let root: Root;

  beforeEach(() => {
    const result = initTestPlexus(new Root({ name: "root" }));
    plexus = result.plexus;
    root = result.root;
  });

  it("child entity UUID is stable after undo + redo", () => {
    const child = new Child({ label: "first" });
    plexus.transact(() => {
      root.child = child;
    });

    const uuidBefore = child.uuid;
    expect(uuidBefore).toBeTruthy();

    plexus.undo();
    // Entity shell survives undo (append-only), but parent wiring is reverted
    expect(root.child).toBeNull();
    // Entity still exists — NOT dematerialized
    // Entity survives undo — append-only shell

    plexus.redo();
    expect(root.child).toBe(child);
    expect(child.uuid).toBe(uuidBefore);
    expect(child.label).toBe("first");
  });

  it("list child UUIDs are stable after undo + redo", () => {
    const a = new Child({ label: "a" });
    const b = new Child({ label: "b" });
    plexus.transact(() => {
      root.children.push(a, b);
    });

    const uuidA = a.uuid;
    const uuidB = b.uuid;

    plexus.undo();
    expect(root.children.length).toBe(0);

    plexus.redo();
    expect(root.children.length).toBe(2);
    expect(root.children[0].uuid).toBe(uuidA);
    expect(root.children[1].uuid).toBe(uuidB);
    expect(root.children[0].label).toBe("a");
    expect(root.children[1].label).toBe("b");
  });

  it("UUID is stable through multiple undo/redo cycles", () => {
    const child = new Child({ label: "cycled" });
    plexus.transact(() => {
      root.child = child;
    });

    const uuid = child.uuid;

    for (let i = 0; i < 5; i++) {
      plexus.undo();
      expect(root.child).toBeNull();
      // Entity survives each undo
      expect(child.uuid).toBe(uuid);

      plexus.redo();
      expect(root.child).toBe(child);
      expect(child.uuid).toBe(uuid);
      expect(child.label).toBe("cycled");
    }
  });

  it("nested child UUIDs are stable after undo + redo", () => {
    const outer = new Child({ label: "outer", nested: new Child({ label: "inner" }) });
    plexus.transact(() => {
      root.child = outer;
    });

    const outerUuid = outer.uuid;
    const inner = outer.nested!;
    const innerUuid = inner.uuid;

    plexus.undo();
    plexus.redo();

    expect(root.child).toBe(outer);
    expect(outer.uuid).toBe(outerUuid);
    expect(outer.nested).toBe(inner);
    expect(outer.nested!.uuid).toBe(innerUuid);
    expect(outer.nested!.label).toBe("inner");
  });

  it("UUID is stable when field value changes between undo/redo", async () => {
    const child = new Child({ label: "v1" });
    plexus.transact(() => {
      root.child = child;
    });

    const uuid = child.uuid;

    // Wait for deferred stopCapturing to separate creation from modification
    await new Promise((r) => setTimeout(r, 0));

    plexus.transact(() => {
      child.label = "v2";
    });

    // Undo the label change only
    plexus.undo();
    expect(child.uuid).toBe(uuid);
    expect(child.label).toBe("v1");

    // Redo the label change
    plexus.redo();
    expect(child.uuid).toBe(uuid);
    expect(child.label).toBe("v2");
  });

  it("UUID is stable through full create-modify-undo-all-redo-all cycle", async () => {
    const child = new Child({ label: "v1" });
    plexus.transact(() => {
      root.child = child;
    });

    const uuid = child.uuid;

    // Wait for deferred stopCapturing
    await new Promise((r) => setTimeout(r, 0));

    plexus.transact(() => {
      child.label = "v2";
    });

    // Undo both (label change + parent wiring)
    plexus.undo(); // label back to v1
    plexus.undo(); // parent wiring reverted
    expect(root.child).toBeNull();
    // Entity shell still alive
    expect(child.uuid).toBe(uuid);

    // Redo creation (parent wiring restored)
    plexus.redo();
    expect(root.child).toBe(child);
    expect(child.uuid).toBe(uuid);
    expect(child.label).toBe("v1");

    // Redo label change
    plexus.redo();
    expect(child.uuid).toBe(uuid);
    expect(child.label).toBe("v2");
  });
});
