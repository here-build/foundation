/**
 * infer-content — the per-run CONTENT sidecar to the structural flow-graph.
 *
 * The flow-graph (`traceToFlowGraph`) is deliberately OPAQUE and value-independent
 * so the layout stays stable across runs (the MDL design's core invariant). But
 * a human debugging "why this prompt" wants to SEE what each infer actually sent
 * and got back. That content is volatile per-run value data — it must NOT live in
 * the structural graph. So it's a separate lookup, keyed by the SAME scope id the
 * flow-graph uses, returning the live `InferenceTask` model(s) each infer scope's
 * instances created. The renderer reads these reactively, so results stream in as
 * the run resolves without ever recomputing the layout.
 *
 * One infer scope (an AST `(infer …)` Pair) may have fired N times (the ×N stack)
 * across distinct prompts — each a distinct task. The content-addressed cache
 * already merges identical prompts, so the deduped list is "the distinct calls
 * this node made."
 */
import { InferenceTask } from "./task.js";
import { scopeId } from "./trace-to-forest.js";
import type { EvalTrace } from "./trace.js";

export function inferTasksByScope(trace: EvalTrace): Map<string, InferenceTask[]> {
  // invocation id → the task it created (invert the trace's task→invocations map).
  const taskByInv = new Map<number, InferenceTask>();
  for (const [task, invs] of trace.invocationByTask) {
    if (!(task instanceof InferenceTask)) continue;
    for (const inv of invs) taskByInv.set(inv.id, task);
  }

  const out = new Map<string, InferenceTask[]>();
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      if (!inv.isProvenancePoint) continue;
      const task = taskByInv.get(inv.id);
      if (!task) continue;
      const sid = scopeId(inv.node);
      let list = out.get(sid);
      if (!list) out.set(sid, (list = []));
      if (!list.includes(task)) list.push(task);
    }
  }
  return out;
}
