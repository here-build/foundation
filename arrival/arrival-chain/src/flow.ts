// Flow-graph view layer — the render-ready `FlowGraph` model + causal cones
// (engine-free, from flow-graph.ts) plus the light Plexus result classes the
// renderer reads (`InferenceTask`/`InferenceResult`/`InferenceError` — plexus +
// mobx + tiny-invariant, no interpreter, no backends, no LLM SDKs).
//
// Import from here to render and select over an inference flow-graph WITHOUT the
// eval runtime that the `.` barrel drags. The PRODUCER (`traceToFlowGraph`,
// EvalTrace → graph) stays on the barrel, where the engine already is.
export type { FlowGraph, FlowGraphNode, FlowGraphEdge, FlowNodeKind } from "./flow-graph.js";
export { flowForwardCone, flowBackwardCone } from "./flow-graph.js";
export { InferenceTask, InferenceResult, InferenceError } from "./task.js";
