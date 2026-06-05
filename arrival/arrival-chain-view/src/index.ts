/**
 * arrival-chain-view — a faithful, deterministic projection of arrival-chain
 * scheme into a target language. Phase 1: JS (read-view). See SPEC.md.
 */
export { projectToJs, projectToJsRaw, type ProjectOptions } from "./project.js";
export { formatJs } from "./format.js";
export { cleanName } from "./names.js";
export { aiClientModule, compilePromptToTs, type CompiledPrompt } from "./prompt.js";
export { projectToPy, pyName, type PyOptions } from "./python.js";
