// @here.build/arrival-sweet — the sweet-expression lens over scheme source.
//
// A zero-dependency leaf (its own S-expr parser; only tiny-invariant). The classic↔sweet view:
// `schemeToSweet` renders stored canonical scheme as a readable "sweet" form (curly-infix, `=>`
// lambda, colon kwargs, `??` coalesce); `sweetToScheme`/`readSweet` fold an edited sweet view back.
// Consumed by the studio editor toggle, codemirror, the chain-view compiler, sift's lowering, and
// provenance region-label rendering — none of which need (or pull) the eval engine.

// The curated lens surface (schemeToSweet/sweetToScheme/readSweet/parseSexprs/printScheme/
// alignSweetClassic/paramHints + their types).
export * from "./sweet.js";

// Additional sweet-render primitives some tools reach for directly (inline vs block rendering,
// kwarg (de)sugaring, structural node equality, the default options).
export {
  inlineSweet,
  inlineScheme,
  formatSweet,
  collectKwargHeads,
  inflateKwargs,
  flattenKwargs,
  nodeEq,
  DEFAULT_OPTS,
} from "./sweet-render.js";

// Lower-level sweet reader utilities (single-expr read; top-form span scan) — used by the
// classic↔sweet round-trip integration tests over the program corpus.
export { readSweetExpr, topFormSpans, splitFormsWithBase } from "./sweet-read.js";
