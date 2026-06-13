/**
 * infer-content — the per-run CONTENT sidecar to the structural flow-graph.
 *
 * The flow-graph (`traceToFlowGraph`) is deliberately OPAQUE and value-independent
 * so the layout stays stable across runs (the MDL design's core invariant). But
 * a human debugging "why this prompt" wants to SEE what each infer actually sent
 * and got back. That content is volatile per-run value data — it must NOT live in
 * the structural graph. So it's a separate lookup, keyed by the SAME scope id the
 * flow-graph uses, returning the live `InferBinding`(s) each infer scope's
 * instances created. The renderer reads these reactively, so results stream in as
 * the run resolves without ever recomputing the layout.
 *
 * One infer scope (an AST `(infer …)` Pair) may have fired N times (the ×N stack)
 * across distinct prompts — each a distinct binding. The content-addressed
 * `InferStore` already merges identical prompts onto one cell, so the deduped
 * list is "the distinct calls this node made."
 */
import { InferBinding } from "@here.build/arrival-inference";
import { scopeId, type EvalTrace } from "@here.build/arrival-provenance";

export function inferTasksByScope(trace: EvalTrace): Map<string, InferBinding[]> {
  // invocation id → the binding it created (invert the trace's binding→invocations map).
  const bindingByInv = new Map<number, InferBinding>();
  for (const [binding, invs] of trace.invocationByTask) {
    if (!(binding instanceof InferBinding)) continue;
    for (const inv of invs) bindingByInv.set(inv.id, binding);
  }

  const out = new Map<string, InferBinding[]>();
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      if (!inv.isProvenancePoint) continue;
      const binding = bindingByInv.get(inv.id);
      if (!binding) continue;
      const sid = scopeId(inv.node);
      let list = out.get(sid);
      if (!list) out.set(sid, (list = []));
      if (!list.includes(binding)) list.push(binding);
    }
  }
  return out;
}
