/**
 * Test to verify that Y.UndoManager operations trigger MobX reactivity via plexus tracking
 */

import { reaction } from "mobx";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => { enableMobXIntegration(); });

@syncing("TestModel")
class TestModel extends PlexusModel {
  @syncing
  accessor name: string = "";
  @syncing
  accessor count: number = 0;
  @syncing
  accessor ref: TestModel | null = null;
}

describe("Y.UndoManager tracking", () => {
  let doc: Y.Doc;
  let testPlexus: TestPlexus<TestModel>;
  let root: TestModel;

  beforeEach(() => {
    const result = initTestPlexus(new TestModel({ name: "initial", count: 0 }));
    doc = result.doc;
    testPlexus = result.plexus;
    root = result.root;
  });

  it("entity survives undo (append-only shell) and restores on redo", () => {
    const ref = new TestModel({ name: "first" });
    testPlexus.transact(() => {
      root.ref = ref;
      ref.name = "second";
    });

    testPlexus.undo();

    expect(root.ref).to.eq(null);
    // Entity survives undo — append-only shell
    expect(ref.uuid).to.be.ok;

    testPlexus.redo();

    expect(root.ref).to.equal(ref);
    expect(ref.name).to.equal("second");
  });

  it("should track modifications from normal operations", () => {
    let notificationCount = 0;

    const dispose = reaction(
      () => root.name,
      () => { notificationCount++; },
    );

    expect(notificationCount).to.equal(0);

    testPlexus.transact(() => {
      root.name = "modified";
    });

    expect(notificationCount).to.equal(1);
    dispose();
  });

  it("should track modifications from UndoManager.undo()", () => {
    let notificationCount = 0;

    const dispose = reaction(
      () => root.name,
      () => { notificationCount++; },
    );

    root.name = "modified";
    expect(notificationCount).to.equal(1);

    testPlexus.undo();
    expect(notificationCount).to.equal(2);

    expect(root.name).to.equal("initial");
    dispose();
  });

  it("should track modifications from UndoManager.redo()", () => {
    let notificationCount = 0;

    const dispose = reaction(
      () => root.name,
      () => { notificationCount++; },
    );

    testPlexus.transact(() => {
      root.name = "modified";
    });
    expect(notificationCount).to.equal(1);

    testPlexus.undo();
    expect(notificationCount).to.equal(2);

    testPlexus.redo();
    expect(notificationCount).to.equal(3);

    expect(root.name).to.equal("modified");
    dispose();
  });

  it("should track modifications from UndoManager for multiple fields", () => {
    let nameNotifications = 0;
    let countNotifications = 0;

    const disposeName = reaction(
      () => root.name,
      () => { nameNotifications++; },
    );

    const disposeCount = reaction(
      () => root.count,
      () => { countNotifications++; },
    );

    testPlexus.transact(() => {
      root.name = "new-name";
      root.count = 42;
    });

    expect(nameNotifications).to.equal(1);
    expect(countNotifications).to.equal(1);

    testPlexus.undo();

    expect(nameNotifications).to.equal(2);
    expect(countNotifications).to.equal(2);

    disposeName();
    disposeCount();
  });
});
