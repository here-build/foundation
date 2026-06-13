// Back-compat shim for the `@here.build/arrival-chain/flow` subpath. The
// engine-free flow-graph view layer moved to `@here.build/arrival-provenance`;
// this re-export keeps the subpath resolving for existing consumers.
export type { FlowGraph, FlowGraphNode, FlowGraphEdge, FlowNodeKind } from "@here.build/arrival-provenance";
export { flowForwardCone, flowBackwardCone } from "@here.build/arrival-provenance";
