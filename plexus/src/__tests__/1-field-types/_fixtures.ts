/**
 * Shared test fixtures for field-type tests
 *
 * These models cover all decorator variants and support testing:
 * - Ephemeral state operations
 * - Materialized state with YJS sync
 * - Mid-materialization transitions
 * - Cross-document synchronization
 */

import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ============================================
// Base test models
// ============================================

@syncing("TestValue")
export class TestValue extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor count: number = 0;
}

@syncing("TestContainer")
export class TestContainer extends PlexusModel {
  // Primitive fields
  @syncing accessor val: TestValue | null = null;
  @syncing.child accessor childVal: TestValue | null = null;

  // Array fields
  @syncing.list accessor list: TestValue[] = [];
  @syncing.child.list accessor childList: TestValue[] = [];

  // Set fields
  @syncing.set accessor set: Set<TestValue> = new Set();
  @syncing.child.set accessor childSet: Set<TestValue> = new Set();

  // Record fields
  @syncing.record accessor record: Record<string, TestValue> = {};
  @syncing.child.record accessor childRecord: Record<string, TestValue> = {};

  // Map field (complex keys)
  @syncing.map accessor map!: Map<string, TestValue>;
  @syncing.map accessor mapWithSetKeys!: Map<Set<TestValue>, string>;
}

@syncing("TestRoot")
export class TestRoot extends PlexusModel<null> {
  // For dependency testing
  dependencies?: Record<string, TestRoot>;

  @syncing.child accessor container: TestContainer | null = null;
  @syncing.child.list accessor containers: TestContainer[] = [];
  @syncing.child.list accessor values: TestValue[] = [];
}

// ============================================
// Inheritance test models
// ============================================

@syncing("ParentModel")
export class ParentModel extends PlexusModel {
  @syncing accessor name: string = "parent-default";
  @syncing.list accessor items: TestValue[] = [];
}

@syncing("ChildModel")
export class ChildModel extends ParentModel {
  // Override with narrower type
  @syncing accessor name: "child-a" | "child-b" = "child-a";

  // Override list to child-list (ownership change)
  @syncing.child.list accessor items: TestValue[] = [];

  // New field only in child
  @syncing accessor childOnly: string = "";
}

// ============================================
// Helper functions
// ============================================

export function createEphemeral(): TestContainer {
  return new TestContainer();
}

export function createWithValues(): TestContainer {
  const v1 = new TestValue({ name: "v1", count: 1 });
  const v2 = new TestValue({ name: "v2", count: 2 });
  return new TestContainer({
    val: v1,
    childVal: v2,
    list: [v1],
    childList: [v2],
    set: new Set([v1]),
    childSet: new Set([v2]),
    record: { a: v1 },
    childRecord: { b: v2 },
    map: new Map([["key", v1]]),
    mapWithSetKeys: new Map(),
  });
}

export function createDependencyVector(documentId: string, setup: (root: TestRoot) => void): Uint8Array {
  const { doc, root } = initTestPlexus(new TestRoot({ container: null, containers: [], values: [] }), {}, documentId);
  setup(root);
  return Y.encodeStateAsUpdate(doc);
}
