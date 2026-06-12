// slice-to-ts.ts — the human-grade render of a reverse-chain slice.
//
// `buildSlice` (arrival-chain) produces the naive baseline: a sound, runnable Scheme reverse
// chain — only the forms a value depends on. This lowers that slice through the deterministic
// arrival→read-view compiler (projectToJs) into idiomatic, formatted source — the human-grade
// artifact a judge reads or runs. Deterministic (no LLM): the compiler is a faithful projection,
// so the rendered program is exactly the slice, just in a familiar surface.
//
// On-demand by design: projectToJs runs eslint --fix + prettier (heavy), so this is an eject-time
// / explicit-call capability, NOT something computed per discovery response.

import { projectToJs, type ProjectOptions } from "./project.js";

/** Lower a reverse-chain slice (a runnable Scheme program string, e.g. `Slice.program` from
 *  arrival-chain's `buildSlice`) into idiomatic, formatted read-view source — the human-grade
 *  render of the derivation. Async (formats via eslint + prettier). */
export function sliceToTypeScript(sliceProgram: string, opts: ProjectOptions = {}): Promise<string> {
  return projectToJs(sliceProgram, opts);
}
