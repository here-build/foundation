/**
 * SubPlexus - A lightweight Plexus for managing immutable dependencies
 *
 * Unlike the main Plexus, SubPlexus:
 * - Treats dependencies as immutable (no observation/sync)
 * - Delegates dependency fetching to root plexus
 * - Handles version resolution and deduplication
 * - Manages nested dependency loading
 */

import * as Y from "yjs";
import { PlexusModel } from "./PlexusModel";
import { Plexus, DependencyId, DependencyVersion } from "./Plexus";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { deref } from "./deref";
import invariant from "tiny-invariant";

export class SubPlexus<
  Root extends PlexusModel,
  ParentPlexus extends Plexus<any, any, any, any> = Plexus<any, any, any, any>,
> {
  private subDependencies = new Map<
    DependencyId,
    SubPlexus<any, ParentPlexus>
  >();
  private dependencyVersions = new Map<DependencyId, DependencyVersion>();
  private resolvedVersion: DependencyVersion;
  private isRootLoaded = false;
  public readonly rootPromise: Promise<Root>;

  constructor(
    public readonly doc: Y.Doc,
    public readonly dependencyId: DependencyId,
    public readonly requestedVersion: DependencyVersion,
    public readonly parentPlexus: ParentPlexus,
    public readonly rootPlexus: Plexus<any, any, any, any>,
  ) {
    // Get the actual resolved version from the doc
    this.resolvedVersion = this.getResolvedVersion();

    // Check global registry with resolved version for deduplication
    const registryKey = this.getRegistryKey();
    const existing = rootPlexus.globalDependencyRegistry.get(registryKey);

    if (existing) {
      // Load root entity and sub-dependencies
      this.rootPromise = existing.plexus.rootPromise;
      return;
    }

    // Register this SubPlexus with its resolved version
    rootPlexus.globalDependencyRegistry.set(registryKey, {
      doc,
      plexus: this as any,
    });

    // Load root entity and sub-dependencies
    this.rootPromise = Promise.resolve().then(() => this.loadRoot());
  }

  private getResolvedVersion(): DependencyVersion {
    // Get the actual version from doc metadata (this is what was actually loaded)
    const metadata = this.doc.getMap(YJS_GLOBALS.metadataMap);
    return (
      (metadata.get(
        YJS_GLOBALS.metadataMapFields.version,
      ) as DependencyVersion) || this.requestedVersion
    );
  }

  private getRegistryKey(): string {
    // Use dependencyId + resolved version as the deduplication key
    return `${this.dependencyId}@${this.resolvedVersion}`;
  }

  private async loadRoot(): Promise<Root> {
    const rootModel = this.doc
      .getMap<Y.Map<any>>(YJS_GLOBALS.models)
      .get("root");
    invariant(
      rootModel,
      `SubPlexus: missing root model for dependency ${this.dependencyId}`,
    );

    // Load sub-dependencies if they exist (no observation - dependencies are immutable)
    const depVersions = rootModel.get("dependencyVersion") as
      | Record<DependencyId, DependencyVersion>
      | undefined;
    if (depVersions) {
      await this.loadSubDependencies(depVersions);
    }

    // Return the root entity (will be materialized by parent's resolver)
    const root = deref(this.doc, ["root"]) as Root;
    this.isRootLoaded = true;
    return root;
  }

  private async loadSubDependencies(
    depVersions: Record<DependencyId, DependencyVersion>,
  ) {
    const deps = Object.entries(depVersions) as [
      DependencyId,
      DependencyVersion,
    ][];

    // Load all sub-dependencies in parallel
    await Promise.all(
      deps.map(async ([depId, requestedVersion]) => {
        // Skip if already loaded
        if (this.subDependencies.has(depId)) return;

        // First, ask root to fetch the dependency doc
        // The fetchDependency might resolve version (e.g. "latest" -> "1.2.3")
        const depDoc = await this.rootPlexus.fetchDependency(
          depId,
          requestedVersion,
        );

        // Check the actual resolved version from the loaded doc
        const depMetadata = depDoc.getMap(YJS_GLOBALS.metadataMap);
        const resolvedVersion =
          (depMetadata.get(
            YJS_GLOBALS.metadataMapFields.version,
          ) as DependencyVersion) || requestedVersion;

        // Check if this exact version is already loaded globally
        const registryKey = `${depId}@${resolvedVersion}`;
        const existing =
          this.rootPlexus.globalDependencyRegistry.get(registryKey);

        if (existing) {
          // Reuse existing SubPlexus
          this.subDependencies.set(
            depId,
            existing.plexus as SubPlexus<any, ParentPlexus>,
          );
          this.dependencyVersions.set(depId, resolvedVersion);
        } else {
          // Create new SubPlexus for this dependency
          const subPlexus = new SubPlexus(
            depDoc,
            depId,
            requestedVersion,
            this.parentPlexus,
            this.rootPlexus,
          );

          this.subDependencies.set(depId, subPlexus);
          this.dependencyVersions.set(depId, resolvedVersion);

          // Wait for it to load its own dependencies
          await subPlexus.rootPromise;
        }
      }),
    );
  }

  /**
   * Get a sub-dependency's SubPlexus
   */
  getSubDependency(
    dependencyId: DependencyId,
  ): SubPlexus<any, ParentPlexus> | undefined {
    return this.subDependencies.get(dependencyId);
  }

  /**
   * Get all sub-dependencies
   */
  getAllSubDependencies(): Map<DependencyId, SubPlexus<any, ParentPlexus>> {
    return new Map(this.subDependencies);
  }

  /**
   * Get the resolved version (what was actually loaded)
   */
  getResolvedVersionInfo(): {
    requested: DependencyVersion;
    resolved: DependencyVersion;
  } {
    return {
      requested: this.requestedVersion,
      resolved: this.resolvedVersion,
    };
  }
}
