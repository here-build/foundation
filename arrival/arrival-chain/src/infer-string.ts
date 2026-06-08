/**
 * InferString — the rich inference response: a string-transparent value that ALSO
 * carries `reasoning` + `chunks` as EXTERNAL-ONLY side-data.
 *
 * It IS a string everywhere scheme looks — it extends the scheme string type
 * (`AString`/`SchemeString`), so `string?`, `string-append`, `string-length`, and
 * `.prompt`/handlebars interpolation all accept it. The program operates on the
 * answer (intent). How that answer came to be — the model's reasoning and the
 * tool-call trajectory (`chunks`) — rides as materialization the HOST / trace / MITM
 * / research plane reads off the instance, but the PROGRAM cannot:
 *   - the fields are `__`-prefixed, so the sandbox `@` accessor gates them (returns
 *     nil — `sandbox-env.ts`'s `if (keyStr.startsWith("_")) return nil`, the same gate
 *     that hides `__string__`), and
 *   - `toJs()` (inherited) returns the bare string, so they never cross the JS
 *     membrane into the program's result either.
 * Same category as `AValue.provenance` — observed externally, never branched on
 * internally. This is intent/materialization at the value level.
 *
 * `withProvenance` MUST be overridden (it is): every exit-tap re-stamps provenance
 * through this method, and the base would mint a PLAIN string — silently dropping the
 * payload. Value-collapsing ops (`string-append`, `substring`) DO drop it, which is
 * correct (a concatenation of two completions has no single reasoning) — read
 * `chunks`/`reasoning` off the RAW `(infer …)` result, which survives binding.
 */
import { AString } from "@here.build/arrival-scheme";

import type { Chunk, ToolCall } from "./model.js";

export class InferString extends AString {
  /** The model's reasoning trace. External-only (`__`-gated + stripped by `toJs`). */
  readonly __reasoning__: string;
  /** The normalized trajectory (text / reasoning / tool_call / tool_result units).
   *  External-only — the research/MITM plane reads it; the program cannot. */
  readonly __chunks__: readonly Chunk[];
  /** The tool calls the model emitted THIS turn (empty ⇒ a final, no-tool turn). Internal
   *  loop-control data: the JS agentic-loop driver reads it to decide dispatch-or-finalize;
   *  `__`-gated from the program exactly like reasoning/chunks (the program drives agentic
   *  behaviour through `infer/agentic/end-to-end`, never raw tool calls). */
  readonly __toolCalls__: readonly ToolCall[];

  constructor(
    text: string,
    reasoning: string,
    chunks: readonly Chunk[],
    toolCalls: readonly ToolCall[] = [],
    provenance?: ReadonlySet<number>,
  ) {
    super(text, provenance);
    this.__reasoning__ = reasoning;
    this.__chunks__ = chunks;
    this.__toolCalls__ = toolCalls;
  }

  /** Preserve the payload across provenance re-stamping (every exit-tap calls this).
   *  Without this override the base mints a plain string and `reasoning`/`chunks`/
   *  `toolCalls` vanish silently — the gotcha the verification spike flagged. */
  override withProvenance(provenance: ReadonlySet<number>): InferString {
    return new InferString(this.__string__, this.__reasoning__, this.__chunks__, this.__toolCalls__, provenance);
  }
}
