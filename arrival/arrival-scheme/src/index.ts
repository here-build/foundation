// Re-export all LIPS interpreter functionality
import { applyFantasyLandPatches } from "./fantasy-land-lips";

export * from "./lips.js";
export * from "./safe_builtins.js";
export * from "./sandbox-env";
export { lipsToJs, jsToLips } from "./rosetta";

applyFantasyLandPatches();
