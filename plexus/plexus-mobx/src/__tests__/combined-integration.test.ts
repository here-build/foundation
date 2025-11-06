/**
 * Tests for using computed() together with enableMobXIntegration
 *
 * This verifies that both integration approaches can work together without
 * conflicts, double-calls, or performance issues.
 */

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {autorun, observable, runInAction} from "mobx";
import {computed, enableMobXIntegration} from "../index";
import {PlexusModel, syncing} from "@here.build/plexus";
import {initTestPlexus} from "./test-helpers";
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

describe("computed() with enableMobXIntegration", () => {
    let doc: Y.Doc;
    let model: TestModel;

    beforeEach(async () => {
        // Enable global integration
        enableMobXIntegration();

        const ephemeral = new TestModel({count: 0, name: "test"});
        const result = await initTestPlexus<TestModel>(ephemeral);
        doc = result.doc;
        model = result.root;
    });

    afterEach(() => {
        doc?.destroy();
    });

    it("should not cause double-calls when both integrations are active", () => {
        let computeCount = 0;
        let reactionCount = 0;

        const computedValue = computed(() => {
            computeCount++;
            return model.count * 2;
        });

        const dispose = autorun(() => {
            computedValue.get();
            reactionCount++;
        });

        expect(computeCount).toBe(1);
        expect(reactionCount).toBe(1);

        // Change should trigger exactly one recomputation and one reaction
        model.count = 5;
        expect(computeCount).toBe(2);
        expect(reactionCount).toBe(2);

        dispose();
    });

    it("should track dependencies correctly with both integrations", () => {
        const values: number[] = [];

        const computedValue = computed(() => {
            return model.count * 2;
        });

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

    it("should handle multiple computed values without interference", () => {
        let compute1Count = 0;
        let compute2Count = 0;

        const doubled = computed(() => {
            compute1Count++;
            return model.count * 2;
        });

        const named = computed(() => {
            compute2Count++;
            return `${model.name}: ${model.count}`;
        });

        const results: string[] = [];

        const dispose = autorun(() => {
            results.push(`${named.get()} (${doubled.get()})`);
        });

        expect(compute1Count).toBe(1);
        expect(compute2Count).toBe(1);
        expect(results).toEqual(["test: 0 (0)"]);

        // Changing count should trigger both computeds
        model.count = 5;
        expect(compute1Count).toBe(2);
        expect(compute2Count).toBe(2);
        expect(results).toEqual(["test: 0 (0)", "test: 5 (10)"]);

        // Changing name should only trigger named computed
        model.name = "updated";
        expect(compute1Count).toBe(2); // Unchanged
        expect(compute2Count).toBe(3);
        expect(results).toEqual(["test: 0 (0)", "test: 5 (10)", "updated: 5 (10)"]);

        dispose();
    });

    it("should work with nested computed and global tracking", () => {
        let innerCount = 0;
        let outerCount = 0;

        const inner = computed(() => {
            innerCount++;
            return model.count * 2;
        });

        const outer = computed(() => {
            outerCount++;
            return inner.get() + model.count;
        });

        const values: number[] = [];

        const dispose = autorun(() => {
            values.push(outer.get());
        });

        expect(innerCount).toBe(1);
        expect(outerCount).toBe(1);
        expect(values).toEqual([0]);

        model.count = 5;
        expect(innerCount).toBe(2);
        expect(outerCount).toBe(2);
        expect(values).toEqual([0, 15]); // (5*2) + 5 = 15

        dispose();
    });

    it("should work with mobx observables and both plexus integrations", () => {
        const mobxState = observable({multiplier: 2});
        let computeCount = 0;

        const computedValue = computed(() => {
            computeCount++;
            return model.count * mobxState.multiplier;
        });

        const results: number[] = [];

        const dispose = autorun(() => {
            results.push(computedValue.get());
        });

        expect(computeCount).toBe(1);
        expect(results).toEqual([0]);

        // Change plexus value
        model.count = 5;
        expect(computeCount).toBe(2);
        expect(results).toEqual([0, 10]);

        // Change mobx value
        runInAction(() => {
            mobxState.multiplier = 3;
        });
        expect(computeCount).toBe(3);
        expect(results).toEqual([0, 10, 15]);

        dispose();
    });

    it("should not have memory leaks with both integrations", () => {
        const computedValue = computed(() => model.count * 2);

        const values: number[] = [];
        const dispose = autorun(() => {
            values.push(computedValue.get());
        });

        model.count = 1;
        model.count = 2;
        expect(values).toEqual([0, 2, 4]);

        dispose();

        // After disposal, no more tracking
        model.count = 100;
        expect(values).toEqual([0, 2, 4]);
    });

    it("should handle rapid changes efficiently", () => {
        let computeCount = 0;
        let reactionCount = 0;

        const computedValue = computed(() => {
            computeCount++;
            return model.count * 2;
        });

        const dispose = autorun(() => {
            computedValue.get();
            reactionCount++;
        });

        const initialComputeCount = computeCount;
        const initialReactionCount = reactionCount;

        // Rapid changes - should batch efficiently
        for (let i = 1; i <= 10; i++) {
            model.count = i;
        }

        // Each change should trigger exactly once
        expect(computeCount - initialComputeCount).toBe(10);
        expect(reactionCount - initialReactionCount).toBe(10);

        dispose();
    });

    it("should handle conditional access patterns correctly", () => {
        let computeCount = 0;

        const computedValue = computed(() => {
            computeCount++;
            if (model.count > 5) {
                return `${model.name}: ${model.count}`;
            }
            return `low: ${model.count}`;
        });

        const values: string[] = [];

        const dispose = autorun(() => {
            values.push(computedValue.get());
        });

        expect(values).toEqual(["low: 0"]);
        expect(computeCount).toBe(1);

        // Count changes but stays <= 5 - name shouldn't be tracked
        model.count = 3;
        expect(values).toEqual(["low: 0", "low: 3"]);
        expect(computeCount).toBe(2);

        // Count goes > 5 - now name is tracked
        model.count = 10;
        expect(values).toEqual(["low: 0", "low: 3", "test: 10"]);
        expect(computeCount).toBe(3);

        // Name change should now trigger recomputation
        model.name = "updated";
        expect(values).toEqual(["low: 0", "low: 3", "test: 10", "updated: 10"]);
        expect(computeCount).toBe(4);

        dispose();
    });

    it("should handle errors without breaking tracking", () => {
        const computedValue = computed(() => {
            if (model.count < 0) {
                throw new Error("Negative count");
            }
            return model.count * 2;
        });

        expect(computedValue.get()).toBe(0);

        model.count = -1;
        expect(() => computedValue.get()).toThrow("Negative count");

        // Should recover after error
        model.count = 5;
        expect(computedValue.get()).toBe(10);
    });

    it("should track same property accessed through different paths", () => {
        let reactionCount = 0;

        // Direct access
        const directComputed = computed(() => model.count);

        // Access through computation
        const doubledComputed = computed(() => model.count * 2);

        const dispose = autorun(() => {
            directComputed.get();
            doubledComputed.get();
            reactionCount++;
        });

        expect(reactionCount).toBe(1);

        // Single change to count should trigger one reaction for both computeds
        model.count = 5;
        expect(reactionCount).toBe(2);

        dispose();
    });
});
