import { PlexusConstructor } from "./PlexusModel";

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
  "unshift"
]);
export const mutableArrayMethodsPreservingLength = new Set<symbol | string>(["copyWithin", "fill", "reverse", "sort"]);
