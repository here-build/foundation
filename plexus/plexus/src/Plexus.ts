/**
 * Plexus Document - Orchestrates YJS and dependencies
 */

import * as Y from "yjs";
import { UndoManager } from "yjs";
import { referenceSymbol, Storageable } from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { maybeTransacting } from "./utils";
import { entityClasses } from "./globals";
import { documentEntityCaches } from "./entity-cache";
import { ConcretePlexusConstructor, PlexusModel } from "./PlexusModel";
import { deref } from "./deref";
import { docPlexus, sharedDependencyDocs, sharedDependencyVersions } from "./plexus-registry";
import { SubPlexus } from "./SubPlexus";

// Global registry for undo notifications - Y entities are singletons anyway
export const undoManagerNotifications = new WeakMap<Y.AbstractType<any>, (event: any) => void>();

export type DependencyId = string;
export type DependencyVersion = string | number;

// Re-export from registry for backward compatibility
export { getDependencyDoc } from "./plexus-registry";

export abstract class Plexus<
  Root extends PlexusModel &
    (
      | {}
      | {
          readonly dependencies: Set<PlexusModel>;
          readonly dependencyVersion?: Record<DependencyId, DependencyVersion>;
        }
    ),
  DependencyRootType extends PlexusModel | null = Root extends {
    readonly dependencies: Set<infer DependencyType>;
  }
    ? DependencyType
    : null,
  DependencyIdType extends DependencyId = DependencyId,
  DependencyVersionType extends DependencyVersion = DependencyVersion,
> {
  static get docPlexus() {
    return docPlexus as WeakMap<Y.Doc, Plexus<any, any, any, any>>;
  }
  // Defer loadRoot() to next tick to ensure child class is fully constructed
  public readonly rootPromise: Promise<Root> = Promise.resolve().then(() =>
    this.loadRoot(),
  );
  private isRootLoaded = false;

  // Use getters to access shared per-doc mappings
  private get dependencyDocs(): Map<DependencyIdType, Y.Doc> {
    return sharedDependencyDocs.get(this.doc) as Map<DependencyIdType, Y.Doc>;
  }

  private get dependencyVersions(): Map<
    DependencyIdType,
    DependencyVersionType
  > {
    return sharedDependencyVersions.get(this.doc) as Map<
      DependencyIdType,
      DependencyVersionType
    >;
  }

  // Hierarchical dependency tracking
  private rootPlexus: Plexus<any, any, any, any> | null = null; // Points to the ultimate root plexus
  public readonly subPlexuses = new Map<
    DependencyIdType,
    SubPlexus<
      any,
      Plexus<Root, DependencyRootType, DependencyIdType, DependencyVersionType>
    >
  >(); // Sub-plexuses for each dependency
  public readonly globalDependencyRegistry: Map<
    string,
    {
      doc: Y.Doc;
      plexus: SubPlexus<
        any,
        Plexus<
          Root,
          DependencyRootType,
          DependencyIdType,
          DependencyVersionType
        >
      >;
    }
  >; // Global registry for deduplication

  // @ts-expect-error
  public readonly undoManager: UndoManager;

  constructor(
    public readonly doc: Y.Doc,
    rootPlexus?: Plexus<any, any, any, any>,
  ) {
    // Allow multiple Plexus instances but track the most recent one
    // Multiple instances will share dependency mappings via DefaultedWeakMap
    if (docPlexus.has(doc)) {
      console.warn(
        "Creating additional Plexus for same doc - will share dependency mappings",
      );
    }
    docPlexus.set(doc, this);

    // Set up hierarchical tracking
    if (rootPlexus) {
      this.rootPlexus = rootPlexus;
      this.globalDependencyRegistry = rootPlexus.globalDependencyRegistry;
    } else {
      // This is the root plexus
      this.rootPlexus = this;
      this.globalDependencyRegistry = new Map();
    }
  }

  protected createDefaultRoot(): Root {
    throw new Error("default root fallback is not supported in this instance");
  }

  // Abstract method for fetching dependencies
  fetchDependency(
    dependencyId: DependencyIdType,
    dependencyVersion?: DependencyVersionType,
  ): Promise<Y.Doc> {
    throw new Error("not implemented");
  }

  /**
   * Add a dependency to this Plexus document.
   * Automatically fetches the dependency, updates version tracking, and adds to root dependencies array.
   */
  async addDependency<T extends DependencyRootType>(
    dependencyId: DependencyIdType,
    dependencyVersion: DependencyVersionType,
  ): Promise<T> {
    const root = await this.rootPromise;
    invariant(
      "dependencies" in root,
      `Root entity does not support dependencies - missing 'dependencies' field`,
    );
    invariant(
      "dependencyVersion" in root,
      `Root entity does not support dependencies - missing 'dependencyVersion' field`,
    );
    // todo should stop the world when we have this feature? maybe
    const depDoc = await this.fetchDependency(dependencyId, dependencyVersion);
    return this.transact(() => {
      this.dependencyDocs.set(dependencyId, depDoc);
      this.dependencyVersions.set(dependencyId, dependencyVersion);

      // Use deref to materialize the dependency root entity
      const depRoot = deref(depDoc, ["root"]) as T;
      invariant(
        depRoot,
        `cannot find root in dependency ${dependencyId}@${dependencyVersion}`,
      );

      // Update root entity with new dependency
      const dependencyVersionMap = root.dependencyVersion as Record<
        DependencyIdType,
        DependencyVersionType
      >;

      root.dependencies.add(depRoot);
      dependencyVersionMap[dependencyId] = dependencyVersion;
      return depRoot;
    });
  }

  /**
   * Update a dependency to a new version.
   * Fetches the new version and updates the root entity.
   */
  async updateDependency(
    dependency: Exclude<DependencyRootType, null>,
    newVersion: DependencyVersionType,
  ): Promise<void> {
    const [_, dependencyId] = dependency[referenceSymbol](this.doc);
    const currentVersionId = this.dependencyVersions.get(
      dependencyId as DependencyIdType,
    );
    if (currentVersionId === newVersion) {
      return;
    }
    const newDoc = await this.fetchDependency(
      dependencyId as DependencyIdType,
      newVersion,
    );
    this.dependencyDocs.set(dependencyId as DependencyIdType, newDoc);
    // todo somehow notify everyone that entities have changed
  }

  protected async loadRoot(): Promise<Root> {
    const modelsMap = this.doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
    let rootModel = modelsMap.get("root");
    // todo wait for doc to sync

    if (!rootModel) {
      // Fresh document - create default root
      const root = this.createDefaultRoot();
      root._uuid = "root";
      root[referenceSymbol](this.doc);
      rootModel = modelsMap.get("root");
      invariant(rootModel, "Failed to create root model");
    }

    // Resolve all dependencies if they exist
    if ("dependencyVersion" in rootModel) {
      const dependencyVersion = rootModel.dependencyVersion;

      await this.resolveDependencies(
        rootModel.dependencyVersion as Record<
          DependencyIdType,
          DependencyVersionType
        >,
      );
      rootModel.observe(async () => {
        if ("dependencyVersion" in rootModel) {
          await this.resolveDependencies(
            rootModel.dependencyVersion as Record<
              DependencyIdType,
              DependencyVersionType
            >,
          );
        }
      });
    }

    const root = deref(this.doc, ["root"]) as any as Root;
    this.isRootLoaded = true;
    // @ts-expect-error
    // noinspection JSConstantReassignment
    this.undoManager = new UndoManager([modelsMap], {
      captureTimeout: 500,
    });

    // Wire up undo/redo notification bridge
    // stack-item-popped is fired for undo operations
    this.undoManager.on("stack-item-popped", (event) => {
      // Deduplicate notifications - only notify each target once
      const notifiedTargets = new Set<Y.AbstractType<any>>();
      for (const yEvents of event.changedParentTypes.values()) {
        for (const event of yEvents) {
          if (!notifiedTargets.has(event.target)) {
            notifiedTargets.add(event.target);
            undoManagerNotifications.get(event.target)?.(event);
          }
        }
      }
    });

    // stack-item-added is fired for redo operations
    this.undoManager.on("stack-item-added", (event) => {
      // Deduplicate notifications - only notify each target once
      const notifiedTargets = new Set<Y.AbstractType<any>>();
      for (const yEvents of event.changedParentTypes.values()) {
        for (const event of yEvents) {
          if (!notifiedTargets.has(event.target)) {
            notifiedTargets.add(event.target);
            undoManagerNotifications.get(event.target)?.(event);
          }
        }
      }
    });

    return root;
  }

  protected async resolveDependencies(
    dependencies: Record<DependencyIdType, DependencyVersionType>,
  ): Promise<void> {
    const missingDependencies = (
      Object.entries(dependencies) as [
        DependencyIdType,
        DependencyVersionType,
      ][]
    ).flatMap(([dependencyId, dependencyVersion]) =>
      this.dependencyVersions.get(dependencyId) !== dependencyVersion
        ? [
            [dependencyId, dependencyVersion] as [
              DependencyIdType,
              DependencyVersionType,
            ],
          ]
        : [],
    );
    if (missingDependencies.length > 0) {
      // todo pause doc updates
      await Promise.all(
        missingDependencies.map(async ([dependencyId, dependencyVersion]) => {
          const depDoc = await this.fetchDependency(
            dependencyId,
            dependencyVersion,
          );
          this.dependencyDocs.set(dependencyId, depDoc);
          this.dependencyVersions.set(dependencyId, dependencyVersion);

          // Create SubPlexus for this dependency to handle nested dependencies
          const { SubPlexus } = await import("./SubPlexus");
          const subPlexus = new SubPlexus(
            depDoc,
            dependencyId,
            dependencyVersion,
            this,
            this.rootPlexus || this,
          );

          this.subPlexuses.set(dependencyId, subPlexus);

          // Wait for sub-dependencies to load
          await subPlexus.rootPromise;
        }),
      );
    }
  }

  /**
   * Load an entity by ID from the main document.
   * REQUIRES: rootPromise to be resolved first.
   * Used for comments, copy-paste, direct navigation.
   */
  loadEntity<T extends PlexusModel>(entityId: string): T | null {
    invariant(
      this.isRootLoaded,
      "Cannot load entities before root is loaded. Await plexus.rootPromise first.",
    );

    // Check cache first
    const cached = documentEntityCaches.get(this.doc).get(entityId)?.deref();
    if (cached) return cached as T;

    // Get from Y.Doc
    const modelData = this.doc
      .getMap<Y.Map<Storageable>>(YJS_GLOBALS.models)
      .get(entityId);
    if (!modelData) return null;

    // Get constructor
    const type = modelData.get(YJS_GLOBALS.modelMetadataType) as string;
    const Constructor = entityClasses.get(type) as
      | ConcretePlexusConstructor
      | undefined;
    invariant(Constructor, `Unknown entity type: ${type}`);

    // Spawn and return
    return new Constructor([entityId, this.doc]) as any as T;
  }

  /**
   * Check if an entity exists in the document.
   * REQUIRES: rootPromise to be resolved first.
   */
  hasEntity(entityId: string): boolean {
    invariant(
      this.isRootLoaded,
      "Cannot check entities before root is loaded. Await plexus.rootPromise first.",
    );

    return this.doc.getMap(YJS_GLOBALS.models).has(entityId);
  }

  /**
   * Get all entity IDs of a specific type.
   * REQUIRES: rootPromise to be resolved first.
   */
  getEntityIds(typeName?: string): string[] {
    invariant(
      this.isRootLoaded,
      "Cannot list entities before root is loaded. Await plexus.rootPromise first.",
    );

    const models = this.doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
    const ids: string[] = [];

    models.forEach((model, id) => {
      if (!typeName || model.get(YJS_GLOBALS.modelMetadataType) === typeName) {
        ids.push(id);
      }
    });

    return ids;
  }

  /**
   * Get entity type by ID.
   * REQUIRES: rootPromise to be resolved first.
   */
  getEntityType(entityId: string): string | null {
    invariant(
      this.isRootLoaded,
      "Cannot get entity type before root is loaded. Await plexus.rootPromise first.",
    );

    const modelData = this.doc
      .getMap<Y.Map<Storageable>>(YJS_GLOBALS.models)
      .get(entityId);
    if (!modelData) return null;

    return modelData.get(YJS_GLOBALS.modelMetadataType) as string;
  }

  /**
   * Execute a function within a transaction.
   * Uses maybeTransacting which handles:
   * - YJS transaction wrapping
   * - Shadow sub-transactions (no-op for nested calls)
   * - Notification batching and flushing
   */
  transact<T>(fn: () => T): T {
    return maybeTransacting(this.doc, fn);
  }
}
