/**
 * Tests for enableMobXIntegration - showcase/simple implementation
 *
 * This tests the global tracking hook integration that makes all plexus
 * property access and modification automatically tracked by MobX.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { autorun, makeAutoObservable, observable, runInAction } from "mobx";
import { enableMobXIntegration } from "../index";
import { PlexusModel } from "@here.build/plexus";
import { syncing } from "@here.build/plexus";
import { initTestPlexus } from "./test-helpers";
import * as Y from "yjs";

@syncing
class Counter extends PlexusModel {
  @syncing
  accessor count!: number;

  @syncing
  accessor name!: string;

  constructor(props: { count: number; name: string }) {
    super(props);
  }
}

@syncing
class NestedModel extends PlexusModel {
  @syncing
  accessor value!: string;

  @syncing
  accessor counter!: Counter;

  constructor(props: { value: string; counter: Counter }) {
    super(props);
  }
}

describe("enableMobXIntegration", () => {
  let doc: Y.Doc;
  let model: Counter;

  beforeEach(async () => {
    // Enable integration before each test
    enableMobXIntegration();

    const ephemeral = new Counter({ count: 0, name: "test" });
    const result = await initTestPlexus<Counter>(ephemeral);
    doc = result.doc;
    model = result.root;
  });

  afterEach(() => {
    doc?.destroy();
  });

  it("should track plexus property access automatically", () => {
    const values: number[] = [];

    const dispose = autorun(() => {
      values.push(model.count);
    });

    expect(values).toEqual([0]);

    model.count = 5;
    expect(values).toEqual([0, 5]);

    model.count = 10;
    expect(values).toEqual([0, 5, 10]);

    dispose();
  });

  it("should track multiple properties independently", () => {
    const countValues: number[] = [];
    const nameValues: string[] = [];

    const disposeCount = autorun(() => {
      countValues.push(model.count);
    });

    const disposeName = autorun(() => {
      nameValues.push(model.name);
    });

    expect(countValues).toEqual([0]);
    expect(nameValues).toEqual(["test"]);

    // Changing count shouldn't trigger name reaction
    model.count = 5;
    expect(countValues).toEqual([0, 5]);
    expect(nameValues).toEqual(["test"]);

    // Changing name shouldn't trigger count reaction
    model.name = "updated";
    expect(countValues).toEqual([0, 5]);
    expect(nameValues).toEqual(["test", "updated"]);

    disposeCount();
    disposeName();
  });

  it("should track nested property access", async () => {
    const counter = new Counter({ count: 42, name: "nested" });
    const nested = new NestedModel({ value: "test", counter });
    const result = await initTestPlexus<NestedModel>(nested);
    const nestedModel = result.root;

    const values: number[] = [];

    const dispose = autorun(() => {
      values.push(nestedModel.counter.count);
    });

    expect(values).toEqual([42]);

    nestedModel.counter.count = 100;
    expect(values).toEqual([42, 100]);

    dispose();
    result.doc.destroy();
  });

  it("should work with mobx observables together", () => {
    const mobxState = observable({ multiplier: 2 });
    const results: number[] = [];

    const dispose = autorun(() => {
      results.push(model.count * mobxState.multiplier);
    });

    expect(results).toEqual([0]);

    // Change plexus value
    model.count = 5;
    expect(results).toEqual([0, 10]);

    // Change mobx value
    runInAction(() => {
      mobxState.multiplier = 3;
    });
    expect(results).toEqual([0, 10, 15]);

    // Change both (but in same transaction, should be one reaction)
    runInAction(() => {
      model.count = 10;
      mobxState.multiplier = 4;
    });
    expect(results).toEqual([0, 10, 15, 40]);

    dispose();
  });

  it("should only trigger reactions when accessed properties change", () => {
    let reactionCount = 0;

    const dispose = autorun(() => {
      // Only access count, not name
      model.count;
      reactionCount++;
    });

    expect(reactionCount).toBe(1);

    // Changing name shouldn't trigger reaction
    model.name = "updated";
    expect(reactionCount).toBe(1);

    // Changing count should trigger reaction
    model.count = 5;
    expect(reactionCount).toBe(2);

    dispose();
  });

  it("should handle rapid changes correctly", () => {
    const values: number[] = [];

    const dispose = autorun(() => {
      values.push(model.count);
    });

    expect(values).toEqual([0]);

    // Multiple rapid changes
    for (let i = 1; i <= 10; i++) {
      model.count = i;
    }

    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    dispose();
  });

  it("should work with conditional access patterns", () => {
    const values: string[] = [];

    const dispose = autorun(() => {
      if (model.count > 5) {
        values.push(`${model.name}: ${model.count}`);
      } else {
        values.push("low");
      }
    });

    expect(values).toEqual(["low"]);

    model.count = 3;
    expect(values).toEqual(["low", "low"]);

    model.count = 10;
    expect(values).toEqual(["low", "low", "test: 10"]);

    // Now name is also being accessed
    model.name = "updated";
    expect(values).toEqual(["low", "low", "test: 10", "updated: 10"]);

    // Count still matters
    model.count = 15;
    expect(values).toEqual(["low", "low", "test: 10", "updated: 10", "updated: 15"]);

    dispose();
  });

  it("should work with derived computations", () => {
    class Store {
      constructor() {
        makeAutoObservable(this);
      }

      get doubled() {
        return model.count * 2;
      }

      get message() {
        return `${model.name}: ${this.doubled}`;
      }
    }

    const store = new Store();
    const messages: string[] = [];

    const dispose = autorun(() => {
      messages.push(store.message);
    });

    expect(messages).toEqual(["test: 0"]);

    model.count = 5;
    expect(messages).toEqual(["test: 0", "test: 10"]);

    model.name = "updated";
    expect(messages).toEqual(["test: 0", "test: 10", "updated: 10"]);

    dispose();
  });

  it("should handle disposal correctly", () => {
    const values: number[] = [];

    const dispose = autorun(() => {
      values.push(model.count);
    });

    model.count = 1;
    expect(values).toEqual([0, 1]);

    dispose();

    // After disposal, changes shouldn't trigger reactions
    model.count = 10;
    model.count = 20;
    expect(values).toEqual([0, 1]);
  });

  it("should work with multiple simultaneous reactions", () => {
    const values1: number[] = [];
    const values2: number[] = [];
    const values3: string[] = [];

    const dispose1 = autorun(() => {
      values1.push(model.count);
    });

    const dispose2 = autorun(() => {
      values2.push(model.count * 2);
    });

    const dispose3 = autorun(() => {
      values3.push(model.name);
    });

    expect(values1).toEqual([0]);
    expect(values2).toEqual([0]);
    expect(values3).toEqual(["test"]);

    model.count = 5;
    expect(values1).toEqual([0, 5]);
    expect(values2).toEqual([0, 10]);
    expect(values3).toEqual(["test"]);

    model.name = "updated";
    expect(values1).toEqual([0, 5]);
    expect(values2).toEqual([0, 10]);
    expect(values3).toEqual(["test", "updated"]);

    dispose1();
    dispose2();
    dispose3();
  });

  it("should track field modifications", () => {
    let accessCount = 0;
    let modifyCount = 0;

    const dispose = autorun(() => {
      accessCount++;
      const _ = model.count;
    });

    expect(accessCount).toBe(1);

    // Modification should trigger reaction
    model.count = 5;
    expect(accessCount).toBe(2);

    dispose();
  });
});
