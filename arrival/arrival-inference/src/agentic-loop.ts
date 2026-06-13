/**
 * The agentic loop driver — the core of `infer/agentic/end-to-end`.
 *
 * V's framing: agentic behaviour lives behind ONE ultra-explicit verb that runs the
 * whole loop and returns the FINAL answer. So a single `(infer …)` never carries tool
 * calls — `toolCalls` are internal loop-control data this driver reads, never a
 * program-visible return shape. The four flows still work without the program ever
 * touching raw tool calls: interception is the middleware chain at `dispatch`, and the
 * "tail of calls = artifact" reads the server tape — both at the resolver level, not here.
 *
 * The loop is JS-encapsulated (not a scheme preamble loop) BECAUSE the program never
 * inspects per-turn tool calls — a scheme loop would only reintroduce a carrier. Each
 * `infer` still routes through the cached/replayed infer seam (cost + replay per turn);
 * each `dispatch` routes through the MCP resolver (middleware + positional tape) — so
 * legibility is preserved in the effect log, turn by turn.
 *
 * One TURN: infer with tools → if the model returned tool calls, dispatch each (in
 * order — the positional server-tape is order-sensitive; parallel dispatch is the
 * lint case, deferred), append the assistant turn + the tool results, loop. No tool
 * calls ⇒ that turn's text is the final answer. A generous round backstop bounds an
 * unconfigured run (a budget middleware overrides it once the chain lands).
 */

import type { ChatMessage } from "./backends/_shared.js";
import type { Chunk, ToolCall } from "./model.js";

/** The backstop round cap: an unconfigured agentic run can't loop forever. Generous —
 *  real agents finish in a handful of rounds; a custom budget middleware (C3) precedes
 *  and overrides this. Not a knob the author models, an escape hatch the framework owns. */
export const DEFAULT_AGENTIC_MAX_ROUNDS = 24;

/** One inference turn's neutral result, as the driver consumes it: the assistant text,
 *  the tool calls it emitted (empty ⇒ final), and any reasoning the backend surfaced. */
export interface AgenticTurn {
  text: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  /** An `(llm …)` entity's observe-only middleware returned `mcp/break` for THIS turn's
   *  inference (e.g. a budget terminator past a threshold): halt the loop immediately, no
   *  dispatch. Flow-4 force-halt, but at the inference seam rather than the dispatch seam. */
  halt?: boolean;
}

/** The loop's live budget state, handed to the middleware chain as `progress` so a
 *  budget-terminator middleware can read it and `mcp/break` past a threshold. (v1 carries
 *  the round counters; `(infer/spent)` is reflective-impure and read in scheme directly.) */
export interface AgenticProgress {
  round: number;
  maxRounds: number;
}

/** The two seams the driver is parameterised over — kept abstract so the loop logic is
 *  unit-testable without an LLM or the MCP transport. The rosetta wiring supplies the
 *  real ones (cached infer over the cell machinery; dispatch over the MCP resolver). */
export interface AgenticDeps {
  /** Run ONE tool-enabled inference turn over the running message list. `progress`
   *  ({round, maxRounds}) is handed through so an `(llm …)` entity's observe-only middleware
   *  can read it and `mcp/break` past a budget (surfaced as a turn with `halt: true`). */
  infer(messages: ChatMessage[], progress: AgenticProgress): Promise<AgenticTurn>;
  /** Dispatch ONE tool call across the MCP membrane (middleware chain + server tape).
   *  `progress` ({round, maxRounds}) is handed to the chain so a budget-terminator
   *  middleware can read it and decide `next` vs `mcp/break`. */
  dispatch(call: ToolCall, progress: AgenticProgress): Promise<unknown>;
  /** Does a dispatch result mean "halt the loop now"? (A middleware returned `mcp/break`
   *  without calling next — flow 4's force-halt.) Kept as a predicate so the driver stays
   *  MCP-agnostic; the wiring passes `isMcpBreak`. The call is suppressed (no tool result
   *  fed back), and the trajectory's tail is the triggering `tool_call` chunk. */
  isHalt?: (result: unknown) => boolean;
  /** Round backstop; defaults to {@link DEFAULT_AGENTIC_MAX_ROUNDS}. */
  maxRounds?: number;
}

/** The loop's outcome: the final assistant text, the full trajectory (the external-only
 *  `chunks` the rich response carries), the rounds taken, and how it ended — a natural
 *  no-tool-call turn (both flags false), the round backstop, or a middleware `mcp/break`. */
export interface AgenticResult {
  text: string;
  chunks: Chunk[];
  rounds: number;
  haltedByBackstop: boolean;
  haltedByBreak: boolean;
}

/** Render a tool result into the `tool` message's string content (the model reads text).
 *  A string passes through; anything else is JSON (null-normalised). The RAW result is
 *  kept on the `tool_result` chunk for the research/MITM plane. */
const toMessageContent = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result ?? null);

const toolCallChunk = (call: ToolCall): Chunk =>
  call.id === undefined
    ? { kind: "tool_call", tool: call.name, arguments: call.arguments }
    : { kind: "tool_call", id: call.id, tool: call.name, arguments: call.arguments };

const toolResultChunk = (call: ToolCall, result: unknown): Chunk =>
  call.id === undefined
    ? { kind: "tool_result", tool: call.name, result }
    : { kind: "tool_result", id: call.id, tool: call.name, result };

/**
 * Drive the agentic loop from an initial message list to a final answer. Returns the
 * final text + the accumulated trajectory; never throws on its own (a `dispatch`/`infer`
 * rejection propagates — the resolver's divergence/inert errors are legible there).
 */
export async function runAgenticLoop(initial: readonly ChatMessage[], deps: AgenticDeps): Promise<AgenticResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_AGENTIC_MAX_ROUNDS;
  const messages: ChatMessage[] = [...initial];
  const chunks: Chunk[] = [];
  let lastText = "";
  for (let round = 1; round <= maxRounds; round++) {
    const turn = await deps.infer(messages, { round, maxRounds });
    if (turn.halt) {
      // An (llm …) middleware broke this turn's inference (e.g. a budget terminator): halt
      // with the PRIOR assistant text as the final answer (this turn produced none).
      return { text: lastText, chunks, rounds: round, haltedByBackstop: false, haltedByBreak: true };
    }
    lastText = turn.text;
    if (turn.reasoning) chunks.push({ kind: "reasoning", text: turn.reasoning });
    if (turn.text) chunks.push({ kind: "text", text: turn.text });
    if (turn.toolCalls.length === 0) {
      // No tool calls ⇒ this turn's text is the final answer.
      return { text: turn.text, chunks, rounds: round, haltedByBackstop: false, haltedByBreak: false };
    }
    // Record the assistant tool-call turn, then dispatch each call in order and feed the
    // results back as `tool` messages keyed by call id.
    messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      chunks.push(toolCallChunk(call));
      const result = await deps.dispatch(call, { round, maxRounds });
      if (deps.isHalt?.(result)) {
        // A middleware broke the chain (mcp/break): suppress the call (no tool_result,
        // nothing fed back) and halt. The trajectory's tail is this `tool_call` chunk —
        // flow 4's artifact.
        return { text: lastText, chunks, rounds: round, haltedByBackstop: false, haltedByBreak: true };
      }
      chunks.push(toolResultChunk(call, result));
      messages.push({ role: "tool", content: toMessageContent(result), toolCallId: call.id });
    }
  }
  // Backstop: the generous round cap was hit without a natural final turn. The partial
  // trajectory is in `chunks`; `lastText` is the most recent assistant text.
  return { text: lastText, chunks, rounds: maxRounds, haltedByBackstop: true, haltedByBreak: false };
}
