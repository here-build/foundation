import { nanoid } from "nanoid";
import * as Y from "yjs";

import { Plexus } from "../../Plexus.js";
import type { PlexusModel } from "../../PlexusModel.js";

/**
 * Test implementation of Plexus for testing purposes.
 * Provides simple dependency resolution from provided dependency docs.
 */
export class TestPlexus<Root extends PlexusModel> extends Plexus<Root> {}

/**
 * Initialize a TestPlexus with a new root entity.
 * This is the primary helper for tests - creates doc, bootstraps root, returns everything.
 */
export function initTestPlexus<Root extends PlexusModel>(
  rootEntity: Root,
  dependencies: Record<string, Y.Doc> = {},
  documentId: string = nanoid(),
): { doc: Y.Doc; plexus: TestPlexus<Root>; root: Root } {
  const doc = new Y.Doc({ guid: documentId });

  const plexus = TestPlexus.bootstrap(rootEntity, documentId, doc);
  for (const [depId, dep] of Object.entries(dependencies)) {
    plexus.addDependency(depId, Y.encodeStateAsUpdate(dep));
  }

  return { doc, plexus, root: plexus.root as Root };
}

/**
 * Connect to an existing doc with TestPlexus.
 * Use when you have a doc that's already been synced/populated.
 */
export function connectTestPlexus<Root extends PlexusModel>(doc: Y.Doc, dependencies: Record<string, Y.Doc> = {}) {
  const plexus = TestPlexus.connect(doc) as TestPlexus<Root>;
  for (const [depId, dep] of Object.entries(dependencies)) {
    plexus.addDependency(depId, Y.encodeStateAsUpdate(dep));
  }

  return { plexus, root: plexus.root };
}
