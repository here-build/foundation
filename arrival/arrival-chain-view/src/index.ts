/**
 * arrival-chain-view — a faithful, deterministic projection of arrival-chain
 * scheme into a target language. Phase 1: JS (read-view).
 */
export { projectToJs, projectToJsRaw, type ProjectOptions } from "./project.js";
export { sliceToTypeScript } from "./slice-to-ts.js";
export { formatJs } from "./format.js";
export { cleanName, nameCandidates } from "./names.js";
export {
  aiClientModule,
  compilePromptToTs,
  type CompiledPrompt,
  getPromptBackend,
  PROMPT_BACKENDS,
  type PromptBackend,
  type PromptModule,
} from "./prompt.js";
export { projectToPy, pyName, type PyOptions } from "./python.js";
export type { PromptDoc, PromptInput } from "./prompt-ir.js";
export { compileProject, type CompileTarget, type EmittedFile } from "./compile-project.js";
export { emitTypes, type EmitTypesResult, type EmitTypesOptions, type Mapping } from "./types-emit.js";
