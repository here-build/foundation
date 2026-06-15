// NOTE: relative imports carry explicit .js extensions (house style, see the other
// foundations/arrival packages) so the EMITTED dist/*.d.ts resolves under nodenext
// consumers (sift). Extensionless specifiers type-check here (bundler-resolution
// consumers too) but silently drop every re-export for a nodenext consumer.
export * from "./ToolInteraction.js";
export * from "./DiscoveryToolInteraction.js";
export * from "./ActionToolInteraction.js";
// MCP-annotated capability: EnvCapability + per-verb { description, args } the discovery
// tool reflects into its catalog + input schema. The FULL tool definition lives here, so
// the transport can offload to it — and this package compacts toward a standalone MCP lib.
export * from "./McpEnvCapability.js";
export * from "./dispatch.js";
export * from "./ArrivalServer.js";
export * from "./resources/index.js";
export * from "./store.js";
export { InMemorySessionStore as InMemoryArrivalSessionStore } from "./InMemorySessionStore.js";

// New value-shaped kernel (parallel to legacy ToolInteraction classes).
export * as kernel from "./kernel/index.js";
