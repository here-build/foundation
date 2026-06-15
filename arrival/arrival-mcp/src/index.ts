// NOTE: relative imports carry explicit .js extensions (house style, see the other
// foundations/arrival packages) so the EMITTED dist/*.d.ts resolves under nodenext
// consumers (sift). Extensionless specifiers type-check here (bundler-resolution
// consumers too) but silently drop every re-export for a nodenext consumer.
export * from "./ToolInteraction.js";
export * from "./DiscoveryToolInteraction.js";
export * from "./ActionToolInteraction.js";
// EnvCapability + per-verb { description, inputSchema } the discovery tool reflects into
// its catalog + input schema — so the transport offloads the whole verb definition here,
// and this package can compact toward a standalone MCP lib.
export * from "./McpEnvCapability.js";
export * from "./dispatch.js";
export * from "./ArrivalServer.js";
export * from "./resources/index.js";
export * from "./store.js";
export { InMemorySessionStore as InMemoryArrivalSessionStore } from "./InMemorySessionStore.js";

// New value-shaped kernel (parallel to legacy ToolInteraction classes).
export * as kernel from "./kernel/index.js";
