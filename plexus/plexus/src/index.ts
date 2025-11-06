/**
 * @here.build/plexus
 *
 * Constraint network for object state superposition through mathematical field dynamics.
 *
 * Transforms traditional inheritance hierarchies into proxy networks where objects
 * exist in quantum superposition until materialization collapses them into specific instances.
 */

// this import should go first
export * from "./utils/defaulted-collections";
export * from "./proxy-runtime-types";

// New decorator-based API
export { PlexusModel, PlexusInit } from "./PlexusModel";
export { syncing } from "./decorators";

// Built-in tracking system
export * from "./tracking";
export * from "./YJS_GLOBALS";

// Plexus document orchestration
export * from "./Plexus";
