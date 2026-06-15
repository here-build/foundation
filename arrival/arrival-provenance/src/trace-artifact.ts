/**
 * The TRACE PROTOCOL — the open-core boundary (ADR-019).
 *
 * The runner emits a `TraceArtifact`; the visualizer reads it. Neither side
 * reaches across the seam for anything else. The artifact is a `RegionGraph`
 * (the blueprint structure `traceToRegions` already produces) carried as a
 * SETTLED, JSON-safe value, plus a `version` so the format can evolve under an
 * explicit compatibility discipline (additive-by-default; a breaking change
 * bumps the version and the visualizer supports the window).
 *
 * Why a serialize step at all — the live render path (`shell.tsx`,
 * `runTraced`) RECOMPUTES the graph in-browser straight off a finished
 * `EvalTrace`, so its region `value`/`meta` fields still hold RAW scheme values
 * (a `Pair`/cons list, a boxed exact/inexact number — `trace-to-regions.ts`
 * stores `value: inv.value` verbatim). `JSON.stringify` would mangle those. The
 * artifact is the same graph with every scheme value lowered to plain JS via the
 * `schemeToJs` membrane, so a trace JSON on disk renders with NO server and NO
 * re-eval (ADR-019 D2/D3).
 *
 * `serializeTrace` / `loadTraceArtifact` are the ONLY format-aware functions —
 * the SERDE discipline used for `GlobalVariant` in `token-variance.ts`. Keep all
 * version-gating here; downstream consumers take `{ graph }` and never branch on
 * the wire shape.
 */
import { schemeToJs } from "@here.build/arrival-scheme";
import invariant from "tiny-invariant";

import { traceToRegions, type Region, type RegionGraph } from "./trace-to-regions.js";
import type { EvalTrace } from "./trace.js";

/**
 * The wire-format version. Bump ONLY on a breaking change to the artifact shape
 * (a removed/renamed field, a changed value encoding). Additive fields — a new
 * optional region property, a new edge kind — do NOT bump it: old visualizers
 * ignore what they don't read, new ones tolerate its absence.
 */
export const TRACE_PROTOCOL_VERSION = 1;

/**
 * The on-the-wire trace. Everything the free visualizer needs from a run —
 * a settled `RegionGraph`, JSON-safe, self-describing by `version`. No cells
 * sidecar: leaf/output regions already carry their settled `value`/`state`
 * inline, and `RegionGraphView`'s `cells` prop is optional (the no-live-cells
 * path `shell.tsx` already renders from).
 */
export interface TraceArtifact {
  /** Matches `TRACE_PROTOCOL_VERSION` at emit time. */
  version: number;
  /** The blueprint structure, with all scheme values lowered to plain JS. */
  graph: RegionGraph;
}

/** Deep-lower one region's scheme-bearing fields (`value`, `meta`) to plain JS,
 *  recursing through a fanout's nested iterations. `schemeToJs` is idempotent on
 *  already-plain JS, so applying it uniformly is safe; everything else on a
 *  region (ids, labels, scopes, `condition`, port strings) is already plain. */
function lowerRegion(region: Region): Region {
  switch (region.kind) {
    case "leaf":
      return { ...region, meta: schemeToJs(region.meta), value: schemeToJs(region.value) };
    case "output":
      return { ...region, value: schemeToJs(region.value) };
    case "fanout":
      return { ...region, iterations: region.iterations.map((body) => body.map(lowerRegion)) };
    case "decision":
      return region; // condition is an already-rendered string; nothing scheme-bearing
  }
}

/**
 * Emit a `TraceArtifact` from a finished `EvalTrace` — `traceToRegions` for the
 * structure, then `schemeToJs` over every scheme-bearing field so the result is
 * JSON-safe. The only emitter-side format-aware function.
 */
export function serializeTrace(trace: EvalTrace): TraceArtifact {
  const graph = traceToRegions(trace);
  return {
    version: TRACE_PROTOCOL_VERSION,
    graph: { ...graph, roots: graph.roots.map(lowerRegion) },
  };
}

/**
 * Read a `TraceArtifact` into the `{ graph }` the visualizer mounts. The only
 * consumer-side format-aware function: gate on `version` here so the renderer
 * never branches on the wire shape. A future major-version artifact is rejected
 * loudly rather than rendered wrong.
 */
export function loadTraceArtifact(artifact: TraceArtifact): { graph: RegionGraph } {
  invariant(
    artifact.version <= TRACE_PROTOCOL_VERSION,
    () =>
      `Trace artifact version ${artifact.version} is newer than this visualizer supports (${TRACE_PROTOCOL_VERSION}). Update the visualizer.`,
  );
  // v1 is the floor — no older format exists to migrate from yet. When one does,
  // migrate-forward by version here (additive fields need no migration).
  return { graph: artifact.graph };
}
