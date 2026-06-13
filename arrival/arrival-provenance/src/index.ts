// @here.build/arrival-provenance — the trace-capture substrate + the analysis
// stack that turns a finished EvalTrace into render-models (forest, statechart,
// region tree, flow graph) and the reverse-chain slicer (uneval/slice). Reads
// finished traces; never drives the evaluator.

export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "./trace.js";
export { extractDefines, type DefineInfo, type SourceLocation } from "./extract-defines.js";
export {
  traceToStatechart,
  forwardCone,
  backwardCone,
  type Statechart,
  type ChartNode,
  type ChartEdge,
  type EdgeKind,
} from "./statechart.js";
export {
  collapseMDL,
  type CandidateBox,
  type BoxType,
  type CollapseParams,
  type CollapseResult,
  type Decision,
} from "./mdl-collapse.js";
export { traceToForest, scopeId, type ForestOptions } from "./trace-to-forest.js";
export {
  traceToFlowGraph,
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
  type FlowGraphOptions,
} from "./trace-to-flow-graph.js";
export { traceToFlowGraphNaive } from "./trace-to-flow-graph-naive.js";
export { traceToChain, type ProvenanceChain, type ChainNode, type ChainEdge } from "./trace-to-chain.js";
export { traceToRegions, type Region, type RegionGraph } from "./trace-to-regions.js";
// Incremental twin of `traceToRegions` — maintains the same RegionGraph in O(Δ) per streamed tick (vs O(N) full rebuild) for the live blueprint render. Parity-locked to traceToRegions.
export { TraceRegionFold } from "./trace-region-fold.js";
export { serializeTrace, loadTraceArtifact, TRACE_PROTOCOL_VERSION, type TraceArtifact } from "./trace-artifact.js";
export { regionBoundaries, type RegionBoundary } from "./region-boundaries.js";
export { buildSlice, writeForm, referencedSymbols, defineNameOf, lastTopLevelForm, resolveReadIds, type Slice } from "./slice.js";
export { buildUneval, type Uneval, type UnevalContainer } from "./uneval.js";
// Plain (serializable) trace snapshot + structural clone — consumed by trace
// tooling and tests that round-trip a trace without the mobx-reactive class.
export { snapshotTrace, type PlainTrace, type PlainInv } from "./trace-snapshot.js";
