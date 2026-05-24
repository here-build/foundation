/**
 * Verification spike for layer-stacks-and-tokens proposal:
 * confirms Plexus supports 3-element tuple keys of the shape
 * `Map<[ChildA, ChildB, string], Value>` in `@syncing.child.map`.
 *
 * Existing tests cover 2-element tuples (`Map<[string, Item], Item>` etc.).
 * This file extrapolates to 3 elements with two PlexusModels + a string,
 * mirroring the proposal's `Map<[SVGFilterLayer, SVGFilterElement, string], string>`.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => { enableMobXIntegration(); });

@syncing("Layer")
class Layer extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("Element")
class Element extends PlexusModel {
  @syncing accessor kind!: string;
}

@syncing("Overrides")
class Overrides extends PlexusModel {
  @syncing.child.map
  accessor m!: Map<[Layer, Element, string], string>;
}

describe("child.map with 3-element tuple key [PlexusModel, PlexusModel, string]", () => {
  it("add, read, update, delete + structural equality + order sensitivity", () => {
    const overrides = new Overrides({ m: new Map() });
    const { root } = initTestPlexus(overrides);

    const layer = new Layer({ name: "filter-layer" });
    const elementA = new Element({ kind: "feGaussianBlur" });
    const elementB = new Element({ kind: "feColorMatrix" });

    // Add
    root.m.set([layer, elementA, "stdDeviation"], "4");
    root.m.set([layer, elementB, "values"], "0 0 0 0 0");
    expect(root.m.size).toBe(2);

    // Read with a freshly constructed equivalent tuple — structural equality
    expect(root.m.get([layer, elementA, "stdDeviation"])).toBe("4");
    expect(root.m.has([layer, elementB, "values"])).toBe(true);

    // Update (same tuple, new value)
    root.m.set([layer, elementA, "stdDeviation"], "8");
    expect(root.m.get([layer, elementA, "stdDeviation"])).toBe("8");
    expect(root.m.size).toBe(2);

    // Order sensitivity: swapping PlexusModels yields a DIFFERENT key
    expect(root.m.has([elementA as unknown as Layer, layer as unknown as Element, "stdDeviation"])).toBe(false);

    // Delete
    expect(root.m.delete([layer, elementA, "stdDeviation"])).toBe(true);
    expect(root.m.has([layer, elementA, "stdDeviation"])).toBe(false);
    expect(root.m.size).toBe(1);
  });
});
