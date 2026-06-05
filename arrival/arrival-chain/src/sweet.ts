// Pure classic↔sweet syntax lens — the readable "sweet" view over canonical
// `.scm` source and the fold back to scheme. This subpath carries ONLY the
// reader + renderer: `sweet-render` imports nothing, `sweet-read` imports only
// `sweet-render`, so neither pulls a line of the eval engine (backends, Plexus,
// the LIPS interpreter, the openai/anthropic SDKs).
//
// Import from here when you want the lens WITHOUT the runtime — e.g. an editor
// UI that renders/edits the sweet view. The barrel `.` export drags the whole
// inference substrate; this one is the few-KB syntax pair on its own.
export { schemeToSweet, type SweetOpts } from "./sweet-render.js";
// Classic-parse primitives for source-to-source consumers (e.g. arrival-chain-view
// projecting scheme → JS/Python). Pure analysis — stays inside the runtime-free lens.
export { parseSexprs, type Node } from "./sweet-render.js";
export { sweetToScheme } from "./sweet-read.js";
// Parameter inlay hints — pure analysis over the classic parse (imports only
// `sweet-render`, so it stays inside this runtime-free lens closure).
export { paramHints, paramHintsSweet, type ParamHint } from "./param-hints.js";
