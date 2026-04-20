/**
 * Temporal Edge Cases Tests
 *
 * Tests for edge cases at the intersection of:
 * - init() decorator phase
 * - Default values in field declarations
 * - Parent-child tracking during construction
 * - Auto-move semantics
 * - clone() behavior with defaults and nested structures
 *
 * These represent "here lieth the dragons" temporal categories where
 * initialization timing can cause subtle bugs.
 */

import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// =============================================================================
// Test Models with Default Values
// =============================================================================

@syncing("RuleSet")
class RuleSet extends PlexusModel {
  @syncing.record accessor values!: Record<string, string>;

  constructor(props: { values?: Record<string, string> } = {}) {
    super(props);
  }
}

@syncing("VariantedRuleSet")
class VariantedRuleSet extends PlexusModel<Mixin> {
  @syncing.list accessor variants!: string[];
  @syncing.child accessor rs!: RuleSet;

  constructor(props: { variants?: string[]; rs?: RuleSet } = {}) {
    super(props);
  }
}

// Model with default child value - mimics Mixin in the real model
@syncing("Mixin")
class Mixin extends PlexusModel {
  @syncing accessor name!: string;
  // Default value creates a new RuleSet if none provided
  @syncing.child accessor rs: RuleSet = new RuleSet({ values: { default: "true" } });
  @syncing.child.list accessor variantedRs!: VariantedRuleSet[];

  constructor(props: { name: string; rs?: RuleSet; variantedRs?: VariantedRuleSet[] }) {
    super(props);
  }
}

// Model with nested defaults
@syncing("Theme")
class Theme extends PlexusModel {
  @syncing.child accessor defaultStyle!: Mixin;
  @syncing.child.list accessor styles!: ThemeStyle[];

  constructor(props: { defaultStyle: Mixin; styles?: ThemeStyle[] }) {
    super(props);
  }
}

@syncing("ThemeStyle")
class ThemeStyle extends PlexusModel<Theme> {
  @syncing accessor selector!: string;
  @syncing.child accessor style!: Mixin;

  constructor(props: { selector: string; style: Mixin }) {
    super(props);
  }
}

// Self-referential model (like Component with primaryVariant/variants)
@syncing("Variant")
class Variant extends PlexusModel<VariantGroup> {
  @syncing accessor name!: string;

  constructor(props: { name: string }) {
    super(props);
  }
}

@syncing("VariantGroup")
class VariantGroup extends PlexusModel {
  @syncing accessor name!: string;
  @syncing.child.list accessor variants!: Variant[];
  // Reference to one of the variants (not child)
  @syncing accessor primaryVariant!: Variant | null;

  constructor(props: { name: string; variants?: Variant[]; primaryVariant?: Variant | null }) {
    super(props);
  }
}

// Tree structure for move tests
@syncing("TreeNode")
class TreeNode extends PlexusModel {
  @syncing accessor name!: string;
  @syncing.child.list accessor children!: TreeNode[];

  constructor(props: { name: string; children?: TreeNode[] }) {
    super(props);
  }
}

// Model with multiple child fields (for move between fields)
@syncing("Container")
class Container extends PlexusModel {
  @syncing accessor name!: string;
  @syncing.child accessor primary!: TreeNode | null;
  @syncing.child.list accessor items!: TreeNode[];
  @syncing.child.record accessor namedItems!: Record<string, TreeNode>;

  constructor(props: {
    name: string;
    primary?: TreeNode | null;
    items?: TreeNode[];
    namedItems?: Record<string, TreeNode>;
  }) {
    super(props);
  }
}

// =============================================================================
// Default Value Tests
// =============================================================================

describe("Default child values", () => {
  describe("Parent tracking with defaults", () => {
    it("default child should have proper parent after construction", () => {
      const mixin = new Mixin({ name: "test", variantedRs: [] });

      // The default RuleSet should have mixin as parent
      expect(mixin.rs).to.be.instanceOf(RuleSet);
      expect(mixin.rs.values).to.deep.equal({ default: "true" });
      expect(mixin.rs.parent).to.equal(mixin);
    });

    it("default child should have proper parent after materialization", () => {
      const mixin = new Mixin({ name: "test", variantedRs: [] });
      const { root } = initTestPlexus(mixin);

      expect(root.rs).to.be.instanceOf(RuleSet);
      expect(root.rs.parent).to.equal(root);
    });

    it("explicit child should replace default with proper parent tracking", () => {
      const explicitRs = new RuleSet({ values: { explicit: "value" } });
      const mixin = new Mixin({ name: "test", rs: explicitRs, variantedRs: [] });

      // Explicit RuleSet should be used instead of default
      expect(mixin.rs).to.equal(explicitRs);
      expect(mixin.rs.values).to.deep.equal({ explicit: "value" });
      expect(mixin.rs.parent).to.equal(mixin);
    });

    it("nested defaults should all have correct parent chain", () => {
      const theme = new Theme({
        defaultStyle: new Mixin({ name: "default", variantedRs: [] }),
        styles: [],
      });

      const { root } = initTestPlexus(theme);

      // theme.defaultStyle.rs should have defaultStyle as parent
      expect(root.defaultStyle.rs.parent).to.equal(root.defaultStyle);
      // theme.defaultStyle should have theme as parent
      expect(root.defaultStyle.parent).to.equal(root);
    });
  });

  describe("Replacing default values", () => {
    it("assigning new child should orphan default", () => {
      const mixin = new Mixin({ name: "test", variantedRs: [] });
      const { root } = initTestPlexus(mixin);

      const defaultRs = root.rs;
      expect(defaultRs.parent).to.equal(root);

      const newRs = new RuleSet({ values: { new: "value" } });
      root.rs = newRs;

      // Default should be orphaned
      expect(defaultRs.parent).to.eq(null);
      // New should be adopted
      expect(newRs.parent).to.equal(root);
      expect(root.rs).to.equal(newRs);
    });

    it("assigning null to optional child with default should orphan default", () => {
      // For this test we need a model where the child field is optional
      @syncing("OptionalChildModel")
      class OptionalChildModel extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child accessor optionalChild: RuleSet | null = new RuleSet({ values: { default: "yes" } });
      }

      const model = new OptionalChildModel({ name: "test" });
      const { root } = initTestPlexus(model);

      const defaultChild = root.optionalChild;
      expect(defaultChild).not.to.eq(null);
      expect(defaultChild!.parent).to.equal(root);

      root.optionalChild = null;

      expect(defaultChild!.parent).to.eq(null);
      expect(root.optionalChild).to.eq(null);
    });
  });
});

// =============================================================================
// Clone with Defaults Tests
// =============================================================================

describe("Clone with default values", () => {
  it("cloning entity with default should clone the default too", () => {
    const mixin = new Mixin({ name: "original", variantedRs: [] });
    const { root } = initTestPlexus(mixin);

    const cloned = root.clone();

    // Cloned should be a different object
    expect(cloned).to.not.equal(root);
    // Cloned rs should be different instance
    expect(cloned.rs).to.not.equal(root.rs);
    // But same values
    expect(cloned.rs.values).to.deep.equal({ default: "true" });
    // And correct parent
    expect(cloned.rs.parent).to.equal(cloned);
  });

  it("cloning entity where default was replaced should clone replacement", () => {
    const replacement = new RuleSet({ values: { replaced: "yes" } });
    const mixin = new Mixin({ name: "original", rs: replacement, variantedRs: [] });
    const { root } = initTestPlexus(mixin);

    const cloned = root.clone();

    expect(cloned.rs.values).to.deep.equal({ replaced: "yes" });
    expect(cloned.rs).to.not.equal(root.rs);
    expect(cloned.rs.parent).to.equal(cloned);
  });

  it("cloning nested defaults should preserve structure", () => {
    const theme = new Theme({
      defaultStyle: new Mixin({ name: "theme-default", variantedRs: [] }),
      styles: [new ThemeStyle({ selector: ".foo", style: new Mixin({ name: "foo-style", variantedRs: [] }) })],
    });

    const { root } = initTestPlexus(theme);
    const cloned = root.clone();

    // All nested entities should be cloned
    expect(cloned.defaultStyle).to.not.equal(root.defaultStyle);
    expect(cloned.defaultStyle.rs).to.not.equal(root.defaultStyle.rs);
    expect(cloned.styles[0]).to.not.equal(root.styles[0]);
    expect(cloned.styles[0].style).to.not.equal(root.styles[0].style);
    expect(cloned.styles[0].style.rs).to.not.equal(root.styles[0].style.rs);

    // Parent chains should be correct
    expect(cloned.defaultStyle.parent).to.equal(cloned);
    expect(cloned.defaultStyle.rs.parent).to.equal(cloned.defaultStyle);
    expect(cloned.styles[0].parent).to.equal(cloned);
    expect(cloned.styles[0].style.parent).to.equal(cloned.styles[0]);
    expect(cloned.styles[0].style.rs.parent).to.equal(cloned.styles[0].style);
  });

  it("cloning should handle self-referential patterns (primaryVariant in variants)", () => {
    const v1 = new Variant({ name: "v1" });
    const v2 = new Variant({ name: "v2" });
    const group = new VariantGroup({
      name: "group",
      variants: [v1, v2],
      primaryVariant: v1, // Reference to item in variants list
    });

    const { root } = initTestPlexus(group);
    const cloned = root.clone();

    // Variants should be cloned
    expect(cloned.variants[0]).to.not.equal(root.variants[0]);
    expect(cloned.variants[1]).to.not.equal(root.variants[1]);

    // primaryVariant should reference the cloned variant, not original
    expect(cloned.primaryVariant).to.equal(cloned.variants[0]).and.not.equal(root.primaryVariant).and.not.equal(v1);
  });
});

// =============================================================================
// Auto-Move During Construction Tests
// =============================================================================

describe("Auto-move during construction", () => {
  it("same child passed to two parents during construction - second wins", () => {
    const child = new TreeNode({ name: "child", children: [] });

    const parent1 = new TreeNode({ name: "parent1", children: [child] });
    expect(parent1.children).to.include(child);
    expect(child.parent).to.equal(parent1);

    const parent2 = new TreeNode({ name: "parent2", children: [child] });

    // Child should move to parent2
    expect(child.parent).to.equal(parent2);
    expect(parent2.children).to.include(child);
    // Parent1 should lose the child
    expect(parent1.children).to.have.lengthOf(0).and.not.include(child);
  });

  it("same child used in multiple fields of same parent", () => {
    const child = new TreeNode({ name: "child", children: [] });

    // This tests what happens when same child is in items AND primary
    const container = new Container({
      name: "container",
      primary: child,
      items: [child], // Same child in both fields
      namedItems: {},
    });

    const { root } = initTestPlexus(container);

    // Child can only have one parent field - last assignment wins
    // The order of field processing matters here
    // Either primary OR items will have the child, not both
    const inPrimary = root.primary === child;
    const inItems = root.items.includes(child);

    // Exactly one should be true (XOR condition)
    // inPrimary !== inItems is true when exactly one is true
    expect(inPrimary !== inItems).to.eq(true);
    // And at least one MUST have it
    expect(inPrimary || inItems).to.eq(true);
    // Parent tracking should still work
    expect(child.parent).to.equal(root);
  });

  it("moving child between fields of same parent", () => {
    const child = new TreeNode({ name: "child", children: [] });
    const container = new Container({
      name: "container",
      primary: null,
      items: [child],
      namedItems: {},
    });

    const { root } = initTestPlexus(container);
    expect(root.items).to.include(child);
    expect(child.parent).to.equal(root);

    // Move to primary
    root.primary = child;

    // Should be removed from items
    expect(root.items).to.not.include(child);
    expect(root.items).to.have.lengthOf(0);
    expect(root.primary).to.equal(child);
    expect(child.parent).to.equal(root);

    // Move to namedItems
    root.namedItems["key"] = child;

    expect(root.primary).to.eq(null);
    expect(root.namedItems["key"]).to.equal(child);
    expect(child.parent).to.equal(root);
  });
});

// =============================================================================
// Clone Auto-Move Interaction Tests
// =============================================================================

describe("Clone and auto-move interaction", () => {
  it("cloning after auto-move should preserve moved state", () => {
    const child = new TreeNode({ name: "child", children: [] });
    const parent1 = new TreeNode({ name: "parent1", children: [child] });
    const parent2 = new TreeNode({ name: "parent2", children: [child] }); // Auto-move

    // parent1 should be empty, parent2 should have child
    expect(parent1.children).to.have.lengthOf(0);
    expect(parent2.children).to.have.lengthOf(1);

    const { root: root1 } = initTestPlexus(parent1);
    const cloned1 = root1.clone();
    expect(cloned1.children).to.have.lengthOf(0);

    // Now materialize and clone parent2
    const { root: root2 } = initTestPlexus(parent2);
    const cloned2 = root2.clone();
    expect(cloned2.children).to.have.lengthOf(1);
    expect(cloned2.children[0].name).to.equal("child");
  });

  it("cloning tree should not affect original tree parent relationships", () => {
    const grandchild = new TreeNode({ name: "grandchild", children: [] });
    const child = new TreeNode({ name: "child", children: [grandchild] });
    const root = new TreeNode({ name: "root", children: [child] });

    const { root: materialized } = initTestPlexus(root);

    // Clone the entire tree
    const cloned = materialized.clone();

    // Original relationships should be intact
    expect(materialized.children[0].parent).to.equal(materialized);
    expect(materialized.children[0].children[0].parent).to.equal(materialized.children[0]);

    // Cloned relationships should be independent
    expect(cloned.children[0].parent).to.equal(cloned);
    expect(cloned.children[0].children[0].parent).to.equal(cloned.children[0]);

    // Modifying cloned tree should not affect original
    cloned.children[0].name = "modified";
    expect(materialized.children[0].name).to.equal("child");
  });
});

// =============================================================================
// Dynamic Child Creation (like ensureVariantSetting pattern)
// =============================================================================

describe("Dynamic child creation patterns", () => {
  // This mimics the ensureVariantSetting pattern from TplTag
  @syncing("VariantSetting")
  class VariantSetting extends PlexusModel<DynamicParent> {
    @syncing.list accessor variants!: string[];
    @syncing.child accessor rs: RuleSet = new RuleSet({ values: {} });

    constructor(props: { variants?: string[]; rs?: RuleSet } = {}) {
      super(props);
    }
  }

  @syncing("DynamicParent")
  class DynamicParent extends PlexusModel {
    @syncing accessor name!: string;
    @syncing.child.list accessor vsettings!: VariantSetting[];

    constructor(props: { name: string; vsettings?: VariantSetting[] }) {
      super(props);
    }

    get baseVariantSetting(): VariantSetting {
      let existing = this.vsettings.find((vs) => vs.variants.length === 0);
      if (!existing) {
        existing = new VariantSetting({ variants: [] });
        this.vsettings.push(existing);
      }
      return existing;
    }

    // Pattern from TplTag.ensureVariantSetting
    ensureVariantSetting(variants: string[]): VariantSetting {
      const variantsSet = new Set(variants);
      let vs = this.vsettings.find(
        (vsetting) => variantsSet.symmetricDifference(new Set(vsetting.variants)).size === 0,
      );
      if (!vs) {
        vs = new VariantSetting({ variants });
        this.vsettings.push(vs);
      }
      return vs;
    }
  }

  it("dynamically created child should have correct parent", () => {
    const parent = new DynamicParent({ name: "parent", vsettings: [] });
    const { root } = initTestPlexus(parent);

    const vs = root.ensureVariantSetting(["hover"]);

    expect(vs.parent).to.equal(root);
    expect(vs.rs.parent).to.equal(vs); // Nested default
    expect(root.vsettings).to.include(vs);
  });

  it("multiple dynamic creations should all have correct parents", () => {
    const parent = new DynamicParent({ name: "parent", vsettings: [] });
    const { root } = initTestPlexus(parent);

    const base = root.baseVariantSetting;
    const hover = root.ensureVariantSetting(["hover"]);
    const focus = root.ensureVariantSetting(["focus"]);
    const hoverFocus = root.ensureVariantSetting(["hover", "focus"]);

    expect(base.parent).to.equal(root);
    expect(hover.parent).to.equal(root);
    expect(focus.parent).to.equal(root);
    expect(hoverFocus.parent).to.equal(root);

    // All nested RuleSets should have correct parents
    expect(base.rs.parent).to.equal(base);
    expect(hover.rs.parent).to.equal(hover);
    expect(focus.rs.parent).to.equal(focus);
    expect(hoverFocus.rs.parent).to.equal(hoverFocus);

    expect(root.vsettings).to.have.lengthOf(4);
  });

  it("cloning parent with dynamically created children should clone all", () => {
    const parent = new DynamicParent({ name: "parent", vsettings: [] });
    const { root } = initTestPlexus(parent);

    root.ensureVariantSetting(["hover"]);
    root.ensureVariantSetting(["focus"]);

    const cloned = root.clone();

    expect(cloned.vsettings).to.have.lengthOf(2);
    expect(cloned.vsettings[0]).to.not.equal(root.vsettings[0]);
    expect(cloned.vsettings[1]).to.not.equal(root.vsettings[1]);
    expect(cloned.vsettings[0].parent).to.equal(cloned);
    expect(cloned.vsettings[1].parent).to.equal(cloned);
    expect(cloned.vsettings[0].rs.parent).to.equal(cloned.vsettings[0]);
    expect(cloned.vsettings[1].rs.parent).to.equal(cloned.vsettings[1]);
  });
});

// =============================================================================
// Edge Case: Union Types in Child Lists
// =============================================================================

describe("Union types in child lists", () => {
  @syncing("StringOrModel")
  class StringOrModel extends PlexusModel {
    @syncing accessor value!: string;
  }

  @syncing("MixedListParent")
  class MixedListParent extends PlexusModel {
    @syncing accessor name!: string;
    // This mimics ChoiceType.options: (string | ChoiceOption)[]
    @syncing.child.list accessor options!: (string | StringOrModel)[];

    constructor(props: { name: string; options?: (string | StringOrModel)[] }) {
      super(props);
    }
  }

  it("mixed list should handle primitives and models correctly", () => {
    const model1 = new StringOrModel({ value: "model1" });
    const model2 = new StringOrModel({ value: "model2" });

    const parent = new MixedListParent({
      name: "parent",
      options: ["string1", model1, "string2", model2],
    });

    const { root } = initTestPlexus(parent);

    expect(root.options).to.have.lengthOf(4).and.have.ordered.members(["string1", model1, "string2", model2]);

    // Models should have parent tracking
    expect(model1.parent).to.equal(root);
    expect(model2.parent).to.equal(root);
  });

  it("cloning mixed list should clone models but preserve primitives", () => {
    const model1 = new StringOrModel({ value: "model1" });

    const parent = new MixedListParent({
      name: "parent",
      options: ["string1", model1, "string2"],
    });

    const { root } = initTestPlexus(parent);
    const cloned = root.clone();

    expect(cloned.options).to.have.lengthOf(3);
    expect(cloned.options[0]).to.equal("string1"); // Primitive preserved
    expect(cloned.options[1]).to.not.equal(model1); // Model cloned
    expect((cloned.options[1] as StringOrModel).value).to.equal("model1");
    expect((cloned.options[1] as StringOrModel).parent).to.equal(cloned);
    expect(cloned.options[2]).to.equal("string2"); // Primitive preserved
  });
});

// =============================================================================
// Edge Case: Deeply Nested Defaults with Clone
// =============================================================================

describe("Deeply nested defaults with clone", () => {
  @syncing("Level3")
  class Level3 extends PlexusModel<Level2> {
    @syncing accessor value: string = "level3-default";
  }

  @syncing("Level2")
  class Level2 extends PlexusModel<Level1> {
    @syncing accessor name!: string;
    @syncing.child accessor nested: Level3 = new Level3({});
  }

  @syncing("Level1")
  class Level1 extends PlexusModel<Level0> {
    @syncing accessor name!: string;
    @syncing.child accessor nested: Level2 = new Level2({ name: "level2-default" });
  }

  @syncing("Level0")
  class Level0 extends PlexusModel {
    @syncing accessor name!: string;
    @syncing.child accessor nested: Level1 = new Level1({ name: "level1-default" });
  }

  it("4-level deep defaults should all have correct parent chain", () => {
    const root = new Level0({ name: "root" });
    const { root: materialized } = initTestPlexus(root);

    // Check entire chain
    expect(materialized.nested.parent).to.equal(materialized);
    expect(materialized.nested.nested.parent).to.equal(materialized.nested);
    expect(materialized.nested.nested.nested.parent).to.equal(materialized.nested.nested);

    // Check default values were used
    expect(materialized.nested.name).to.equal("level1-default");
    expect(materialized.nested.nested.name).to.equal("level2-default");
    expect(materialized.nested.nested.nested.value).to.equal("level3-default");
  });

  it("cloning 4-level deep defaults should clone entire chain", () => {
    const root = new Level0({ name: "root" });
    const { root: materialized } = initTestPlexus(root);
    const cloned = materialized.clone();

    // All should be different instances
    expect(cloned).to.not.equal(materialized);
    expect(cloned.nested).to.not.equal(materialized.nested);
    expect(cloned.nested.nested).to.not.equal(materialized.nested.nested);
    expect(cloned.nested.nested.nested).to.not.equal(materialized.nested.nested.nested);

    // All should have correct parent chain
    expect(cloned.nested.parent).to.equal(cloned);
    expect(cloned.nested.nested.parent).to.equal(cloned.nested);
    expect(cloned.nested.nested.nested.parent).to.equal(cloned.nested.nested);

    // Values should be preserved
    expect(cloned.nested.name).to.equal("level1-default");
    expect(cloned.nested.nested.name).to.equal("level2-default");
    expect(cloned.nested.nested.nested.value).to.equal("level3-default");
  });
});
