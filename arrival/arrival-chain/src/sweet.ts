// Pure classic↔sweet syntax lens — the readable "sweet" view over canonical
// `.scm` source and the fold back to scheme. This subpath carries ONLY the
// reader + renderer: `sweet-render` imports nothing, `sweet-read` imports only
// `sweet-render`, so neither pulls a line of the eval engine (backends, Plexus,
// the LIPS interpreter, the openai/anthropic SDKs).
//
// Import from here when you want the lens WITHOUT the runtime — e.g. an editor
// UI that renders/edits the sweet view. The barrel `.` export drags the whole
// inference substrate; this one is the few-KB syntax pair on its own.
export { schemeToSweet, type SweetOpts } from "@here.build/arrival-scheme";
// Classic-parse primitives for source-to-source consumers (e.g. arrival-chain-view
// projecting scheme → JS/Python). Pure analysis — stays inside the runtime-free lens.
export { parseSexprs, printScheme, type Node } from "@here.build/arrival-scheme";
export { sweetToScheme, readSweet } from "./sweet-read.js";
// Sweet↔classic span alignment — pairs the spans both transforms already stamp
// (lockstep walk over the structurally-equal trees). Coordinate substrate for
// IDE features in the sweet view; same runtime-free closure.
export { alignSweetClassic, type SweetAlignment, type SweetSpanPair } from "./sweet-align.js";
// Parameter inlay hints — pure analysis over the classic parse (imports only
// `sweet-render`, so it stays inside this runtime-free lens closure).
export { paramHints, paramHintsSweet, type ParamHint } from "./param-hints.js";
