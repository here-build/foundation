// handle-provenance.ts — the why/where/how/dag trichotomy+ over a ResultHandle.
//
// All four project ONE `buildSlice(trace, outputNode)` / `traceToFlowGraph(trace)` — the
// Buneman/Green–Tannen provenance classification. They are ASYNC because the trace is the TELEOLOGICAL
// view, built lazily by a replay-bound re-run on first ask (`handle.teleological()`). If that re-run
// is too large to trace, `teleological()` throws a "provenance unavailable" door — the handle's VALUE
// is unaffected, so discovery keeps operating on the data.

import { buildSlice, traceToFlowGraph } from "@here.build/arrival-provenance";

import type { ResultHandle } from "./result-handle.js";

/** why-provenance / lineage: the provenance-point ids the value depends on (the evidence reads). */
export async function whyOf(h: ResultHandle, signal?: AbortSignal): Promise<number[]> {
  const { trace, outputNode } = await h.teleological(signal);
  return buildSlice(trace, outputNode).points;
}

/** where-provenance / location: `scopeId` (`head@line:col`) of each kept form. */
export async function whereOf(h: ResultHandle, signal?: AbortSignal): Promise<string[]> {
  const { trace, outputNode } = await h.teleological(signal);
  return buildSlice(trace, outputNode).scopeIds;
}

/** how-provenance / derivation: a runnable Scheme slice that re-derives the value. */
export async function howOf(h: ResultHandle, signal?: AbortSignal): Promise<string> {
  const { trace, outputNode } = await h.teleological(signal);
  return buildSlice(trace, outputNode).program;
}

/** The console overview: the run's computation DAG as homoiconic S-EXPRESSION data — nodes (each
 *  form's scope-id + label + box-type + fan-out count + causal layer) and edges (field-qualified
 *  dataflow, loopbacks marked). Richest for infer/effect-bearing pipelines. */
export async function dagOf(h: ResultHandle, signal?: AbortSignal): Promise<string> {
  const { trace } = await h.teleological(signal);
  const g = traceToFlowGraph(trace);
  const s = (x: string): string => JSON.stringify(x);
  const node = (n: (typeof g.nodes)[number]): string =>
    `    (node ${s(n.id)} :label ${s(n.label)} :box ${n.boxType}` +
    (n.count > 1 ? ` :count ${n.count}` : "") +
    (n.layer != null ? ` :layer ${n.layer}` : "") +
    (n.parentId ? ` :parent ${s(n.parentId)}` : "") +
    ")";
  const edge = (e: (typeof g.edges)[number]): string =>
    `    (-> ${s(e.from)} ${s(e.to)}` +
    (e.kind === "loopback" ? " :loopback #t" : "") +
    (e.fields?.length ? ` :fields (${e.fields.map(s).join(" ")})` : "") +
    ")";
  return `(dag\n  (nodes\n${g.nodes.map(node).join("\n")})\n  (edges\n${g.edges.map(edge).join("\n")}))`;
}
