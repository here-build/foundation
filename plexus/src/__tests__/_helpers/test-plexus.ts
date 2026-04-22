import { nanoid } from "nanoid";
import { onTestFinished } from "vitest";
import * as Y from "yjs";

import { Plexus } from "../../Plexus.js";
import type { PlexusModel } from "../../PlexusModel.js";

/**
 * Test implementation of Plexus for testing purposes.
 * Provides simple dependency resolution from provided dependency docs.
 */
export class TestPlexus<Root extends PlexusModel> extends Plexus<Root> {}

/**
 * Register automatic Y.Doc cleanup. Call inside any helper that creates a doc
 * for a test — the doc is destroyed when the current test finishes, preventing
 * handle accumulation across the ~2k-test suite. Safe outside a test context
 * (no-op).
 */
function registerDocCleanup(doc: Y.Doc) {
  try {
    onTestFinished(() => {
      doc.destroy();
    });
  } catch {
    // Called outside an active test (e.g. module init) — caller is responsible.
  }
}

/**
 * Initialize a TestPlexus with a new root entity.
 * This is the primary helper for tests - creates doc, bootstraps root, returns everything.
 *
 * Automatically registers `doc.destroy()` with vitest's `onTestFinished` so
 * individual test files don't need explicit afterEach cleanup.
 */
export function initTestPlexus<Root extends PlexusModel>(
  rootEntity: Root,
  dependencies: Record<string, Y.Doc> = {},
  documentId: string = nanoid(),
): { doc: Y.Doc; plexus: TestPlexus<Root>; root: Root } {
  const doc = new Y.Doc({ guid: documentId });
  registerDocCleanup(doc);

  const plexus = TestPlexus.bootstrap(rootEntity, documentId, doc);
  for (const [depId, dep] of Object.entries(dependencies)) {
    plexus.addDependency(depId, Y.encodeStateAsUpdate(dep));
  }

  return { doc, plexus, root: plexus.root as Root };
}

/**
 * Connect to an existing doc with TestPlexus.
 * Use when you have a doc that's already been synced/populated.
 *
 * Does NOT register cleanup — the caller owns the doc lifecycle (if they
 * created it via `initTestPlexus`, cleanup is already registered there).
 */
export function connectTestPlexus<Root extends PlexusModel>(doc: Y.Doc, dependencies: Record<string, Y.Doc> = {}) {
  const plexus = TestPlexus.connect(doc) as TestPlexus<Root>;
  for (const [depId, dep] of Object.entries(dependencies)) {
    plexus.addDependency(depId, Y.encodeStateAsUpdate(dep));
  }

  return { plexus, root: plexus.root };
}
