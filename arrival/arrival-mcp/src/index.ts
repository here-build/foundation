// NOTE: relative imports carry explicit .js extensions (house style, see the other
// foundations/arrival packages) so the EMITTED dist/*.d.ts resolves under nodenext
// consumers (sift). Extensionless specifiers type-check here (bundler-resolution
// consumers too) but silently drop every re-export for a nodenext consumer.
// ToolInteraction base + DiscoveryToolInteraction stay for sift's discovery (sift migrates in parallel);
// ActionToolInteraction is gone — the mutation tier is the value-shape ActionTool.
export * from "./ToolInteraction.js";
export * from "./DiscoveryToolInteraction.js";
// EnvCapability + per-verb { description, inputSchema } the discovery tool reflects into
// its catalog + input schema — so the transport offloads the whole verb definition here,
// and this package can compact toward a standalone MCP lib.
export * from "./McpEnvCapability.js";
// Value-shaped discovery tool: `new DiscoveryTool(name, capability, {description})` — the
// subclass-free shell that derives schema + catalog + eval from the one aggregating capability.
export * from "./DiscoveryTool.js";
// Value-shaped mutation tool: `new ActionTool(name, {description, context, clusters})` — the
// subclass-free, FieldSpec-typed, receiver-dispatched, clustered batch tier. Absorbed the interim
// `kernel.defineActionTool`; `defineCluster` + the refs/primitives back its action declarations.
export * from "./ActionTool.js";
// FieldSpec/Ref system (str/num/oneOf/defineRef/uuidShape/…) backing ActionTool context + props.
export * from "./refs.js";
// Typed error kernel (MCPError, withTimeout, size limits) used by ActionTool dispatch.
export * from "./errors.js";
// Wire DiscoveryTool/ActionTool onto the official @modelcontextprotocol/sdk Server (describe→list,
// call→call), plus the legacy ToolInteraction→McpTool bridge (still used by sift's discovery).
export * from "./sdk-adapter.js";
// dispatch.js: serializeResult (used by sdk-adapter + tool test-apps) + the legacy
// dispatchTool/getToolDefinitions (sift's discovery + custdev loops still speak the class array).
export * from "./dispatch.js";
export * from "./resources/index.js";
export * from "./store.js";
export { InMemorySessionStore as InMemoryArrivalSessionStore } from "./InMemorySessionStore.js";
