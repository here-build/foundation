import * as Y from "yjs";
import { DependencyId, DependencyVersion, Plexus } from "../Plexus";
import { referenceSymbol } from "../proxy-runtime-types";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { PlexusModel } from "../PlexusModel";
import { nanoid } from "nanoid";

/**
 * Test implementation of Plexus for testing purposes.
 * Provides simple dependency resolution from provided dependency docs.
 */
export class TestPlexus<
  Root extends PlexusModel &
    (
      | {}
      | {
          readonly dependencies: Set<PlexusModel>;
          readonly dependencyVersion: Record<DependencyId, DependencyVersion>;
        }
    )
> extends Plexus<Root> {
  protected createDefaultRoot(): Root {
    return null as any;
  }
  private availableDependencies: Map<string, () => Promise<Y.Doc>> = new Map(); // For dynamic dependency creation

  constructor(
    doc: Y.Doc,
    private readonly dependencies: Record<string, Y.Doc> = {}
  ) {
    super(doc);
  }

  /**
   * Register a dependency factory for testing
   */
  registerDependencyFactory(dependencyId: string, factory: () => Promise<Y.Doc>) {
    this.availableDependencies.set(dependencyId, factory);
  }

  async fetchDependency(dependencyId: string, dependencyVersion?: string): Promise<Y.Doc> {
    // First check if we have a pre-created dependency doc
    let depDoc = this.dependencies[dependencyId];

    // If not, try the factory
    if (!depDoc && this.availableDependencies.has(dependencyId)) {
      depDoc = await this.availableDependencies.get(dependencyId)!();
      this.dependencies[dependencyId] = depDoc; // Cache it
    }

    if (!depDoc) {
      throw new Error(`Dependency "${dependencyId}" not found in test dependencies`);
    }

    // Always ensure the dependency doc has the correct documentId for cross-doc references
    // This overrides whatever default was set during initialization
    const metadata = depDoc.getMap(YJS_GLOBALS.metadataMap);
    metadata.set(YJS_GLOBALS.metadataMapFields.documentId, dependencyId);

    return depDoc;
  }
}

/**
 * Create a TestPlexus instance and wait for root to load
 */
export async function createTestPlexus<Root extends PlexusModel>(
  doc: Y.Doc,
  dependencies: Record<string, Y.Doc> = {},
): Promise<{ plexus: TestPlexus<Root>; root: Root }> {
  const plexus = new TestPlexus<Root>(doc, dependencies);
  const root = await plexus.rootPromise;
  return { plexus: plexus, root };
}

/**
 * Initialize a document with test data and return a Plexus instance
 */
export async function initTestPlexus<
  Root extends PlexusModel &
    (
      | {}
      | {
          readonly dependencies: Set<PlexusModel>;
          readonly dependencyVersion: Record<DependencyId, DependencyVersion>;
        }
    )
>(
  rootEntity: Root,
  dependencies: Record<string, Y.Doc> = {},
  documentId?: string
): Promise<{ doc: Y.Doc; plexus: TestPlexus<Root>; root: Root }> {
  const doc = new Y.Doc();

  // Create Plexus instance first - this registers the doc
  const plexus = new TestPlexus<Root>(doc, dependencies);

  // Force root UUID and materialize
  rootEntity._uuid = "root";
  rootEntity[referenceSymbol](doc);

  // Set up metadata
  const metadata = doc.getMap(YJS_GLOBALS.metadataMap);
  metadata.set(
    YJS_GLOBALS.metadataMapFields.documentId,
    documentId ?? nanoid(),
  );

  // Load the root through Plexus
  const root = await plexus.rootPromise;

  return { doc, plexus: plexus, root };
}
