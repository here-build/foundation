import type { PlexusConstructor } from "./PlexusModel.js";

export const entityClasses = new Map<string, PlexusConstructor>();
export const mutableArrayMethods = new Set<symbol | string>([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
