/**
 * Tests for computed() - granular integration with single atom per changeset
 *
 * This tests the plexus tracking integration with MobX computed values,
 * where each plexus change creates a single atom notification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { autorun, observable, runInAction } from "mobx";
import { computed } from "../observer";
import { PlexusModel } from "@here.build/plexus";
import { syncing } from "@here.build/plexus";
import { initTestPlexus } from "./test-helpers";
import * as Y from "yjs";

@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor count!: number;

  @syncing
  accessor name!: string;

  constructor(props: { count: number; name: string }) {
    super(props);
  }
}

describe("computed() with plexus tracking", () => {
  let doc: Y.Doc;
  let model: TestModel;

  beforeEach(async () => {
    const ephemeral = new TestModel({ count: 0, name: "test" });
    const result = await initTestPlexus<TestModel>(ephemeral);
    doc = result.doc;
    model = result.root;
  });

  afterEach(() => {
    doc?.destroy();
  });

  it("should track plexus property access in computed", () => {
    const computedValue = computed(() => model.count * 2);

    expect(computedValue.get()).toBe(0);

    model.count = 5;
    expect(computedValue.get()).toBe(10);
  });

  it("should react to plexus changes in autorun", () => {
    const values: number[] = [];

    const computedValue = computed(() => model.count * 2);

    const dispose = autorun(() => {
      values.push(computedValue.get());
    });

    expect(values).toEqual([0]);

    model.count = 5;
    expect(values).toEqual([0, 10]);

    model.count = 10;
    expect(values).toEqual([0, 10, 20]);

    dispose();
  });

  it("should handle multiple property access", () => {
    const computedValue = computed(() => {
      return `${model.name}: ${model.count}`;
    });

    expect(computedValue.get()).toBe("test: 0");

    model.name = "updated";
    expect(computedValue.get()).toBe("updated: 0");

    model.count = 42;
    expect(computedValue.get()).toBe("updated: 42");
  });

  it("should only recompute when dependencies change", () => {
    let computeCount = 0;

    const computedValue = computed(() => {
      computeCount++;
      return model.count * 2;
    }, {
      keepAlive: true
    });

    // Initial computation
    expect(computedValue.get()).toBe(0);
    expect(computeCount).toBe(1);

    // Should use cached value
    expect(computedValue.get()).toBe(0);
    expect(computeCount).toBe(1);

    // Should recompute
    model.count = 5;
    expect(computedValue.get()).toBe(10);
    expect(computeCount).toBe(2);

    // Should use cached value again
    expect(computedValue.get()).toBe(10);
    expect(computeCount).toBe(2);
  });

  it("should work with mobx observables", () => {
    const mobxState = observable({ factor: 2 });

    const computedValue = computed(() => {
      return model.count * mobxState.factor;
    });

    expect(computedValue.get()).toBe(0);

    // Change plexus value
    model.count = 5;
    expect(computedValue.get()).toBe(10);

    // Change mobx value
    runInAction(() => {
      mobxState.factor = 3;
    });
    expect(computedValue.get()).toBe(15);
  });

  it("should create single atom per changeset", () => {
    let reactionCount = 0;

    const computedValue = computed(() => {
      return model.count + model.count; // Access same property twice
    });

    const dispose = autorun(() => {
      computedValue.get();
      reactionCount++;
    });

    expect(reactionCount).toBe(1);

    // Single change should trigger single reaction
    model.count = 5;
    expect(reactionCount).toBe(2);

    dispose();
  });

  it("should handle nested computed values", () => {
    const double = computed(() => model.count * 2);
    const quadruple = computed(() => double.get() * 2);

    expect(quadruple.get()).toBe(0);

    model.count = 5;
    expect(quadruple.get()).toBe(20);
  });

  it("should support IComputedValueOptions", () => {
    let computeCount = 0;

    const computedValue = computed(
      () => {
        computeCount++;
        return model.count * 2;
      },
      {
        name: "testComputed",
        keepAlive: false,
      }
    );

    expect(computedValue.get()).toBe(0);
    expect(computeCount).toBe(1);
  });

  it("should handle errors in computed function", () => {
    const computedValue = computed(() => {
      if (model.count < 0) {
        throw new Error("Negative count");
      }
      return model.count * 2;
    });

    expect(computedValue.get()).toBe(0);

    model.count = -1;
    expect(() => computedValue.get()).toThrow("Negative count");
  });

  it("should properly dispose and not leak memory", () => {
    const computedValue = computed(() => model.count * 2);

    const values: number[] = [];
    const dispose = autorun(() => {
      values.push(computedValue.get());
    });

    model.count = 1;
    expect(values).toEqual([0, 2]);

    dispose();

    // After disposal, changes shouldn't trigger reactions
    model.count = 10;
    expect(values).toEqual([0, 2]); // Still the same
  });
});
