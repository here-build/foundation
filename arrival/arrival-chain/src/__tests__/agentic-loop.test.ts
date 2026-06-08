import { describe, expect, it } from "vitest";

import { DEFAULT_AGENTIC_MAX_ROUNDS, runAgenticLoop, type AgenticDeps, type AgenticTurn } from "../agentic-loop.js";
import type { ChatMessage } from "../backends/_shared.js";
import type { ToolCall } from "../model.js";

/** Build an `infer` that yields the given turns in order (one per round). */
function scriptedInfer(turns: AgenticTurn[]): { infer: AgenticDeps["infer"]; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    seen,
    infer: async (messages) => {
      seen.push(messages.map((m) => ({ ...m }))); // snapshot the messages this turn saw
      const turn = turns[i] ?? { text: "(exhausted)", toolCalls: [] };
      i += 1;
      return turn;
    },
  };
}

const finalTurn = (text: string): AgenticTurn => ({ text, toolCalls: [] });
const callTurn = (text: string, calls: ToolCall[]): AgenticTurn => ({ text, toolCalls: calls });

describe("runAgenticLoop", () => {
  it("returns immediately when the first turn has no tool calls", async () => {
    const { infer, seen } = scriptedInfer([finalTurn("done")]);
    const dispatched: ToolCall[] = [];
    const res = await runAgenticLoop([{ role: "user", content: "hi" }], {
      infer,
      dispatch: async (c) => (dispatched.push(c), null),
    });
    expect(res).toEqual({ text: "done", chunks: [{ kind: "text", text: "done" }], rounds: 1, haltedByBackstop: false });
    expect(dispatched).toEqual([]); // nothing dispatched
    expect(seen).toHaveLength(1);
  });

  it("dispatches a tool call, feeds the result back, and finalizes on the next turn", async () => {
    const call: ToolCall = { id: "c1", name: "create_issue", arguments: { title: "Bug" } };
    const { infer, seen } = scriptedInfer([callTurn("", [call]), finalTurn("filed it")]);
    const dispatched: ToolCall[] = [];
    const res = await runAgenticLoop([{ role: "user", content: "file a bug" }], {
      infer,
      dispatch: async (c) => {
        dispatched.push(c);
        return { id: 7 };
      },
    });

    expect(res.text).toBe("filed it");
    expect(res.rounds).toBe(2);
    expect(res.haltedByBackstop).toBe(false);
    // The trajectory: tool_call → tool_result → final text (no text chunk for the empty
    // assistant tool turn).
    expect(res.chunks).toEqual([
      { kind: "tool_call", id: "c1", tool: "create_issue", arguments: { title: "Bug" } },
      { kind: "tool_result", id: "c1", tool: "create_issue", result: { id: 7 } },
      { kind: "text", text: "filed it" },
    ]);
    expect(dispatched).toEqual([call]);

    // Round 2 saw: the original user msg + the assistant tool-call turn + the tool result
    // (object result JSON-stringified into the tool message content).
    expect(seen[1]).toEqual([
      { role: "user", content: "file a bug" },
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", content: '{"id":7}', toolCallId: "c1" },
    ]);
  });

  it("dispatches a parallel tool batch in order within one turn", async () => {
    const a: ToolCall = { id: "a", name: "f", arguments: {} };
    const b: ToolCall = { id: "b", name: "g", arguments: {} };
    const { infer, seen } = scriptedInfer([callTurn("working", [a, b]), finalTurn("ok")]);
    const order: string[] = [];
    const res = await runAgenticLoop([{ role: "user", content: "do both" }], {
      infer,
      dispatch: async (c) => {
        order.push(c.name);
        return `r-${c.name}`;
      },
    });
    expect(order).toEqual(["f", "g"]); // sequential, in emitted order
    expect(res.chunks).toEqual([
      { kind: "text", text: "working" },
      { kind: "tool_call", id: "a", tool: "f", arguments: {} },
      { kind: "tool_result", id: "a", tool: "f", result: "r-f" },
      { kind: "tool_call", id: "b", tool: "g", arguments: {} },
      { kind: "tool_result", id: "b", tool: "g", result: "r-g" },
      { kind: "text", text: "ok" },
    ]);
    // Round 2 saw both tool results appended after the assistant turn.
    expect(seen[1]).toEqual([
      { role: "user", content: "do both" },
      { role: "assistant", content: "working", toolCalls: [a, b] },
      { role: "tool", content: "r-f", toolCallId: "a" },
      { role: "tool", content: "r-g", toolCallId: "b" },
    ]);
  });

  it("records a reasoning chunk when the turn carries one", async () => {
    const { infer } = scriptedInfer([{ text: "answer", toolCalls: [], reasoning: "because" }]);
    const res = await runAgenticLoop([{ role: "user", content: "q" }], { infer, dispatch: async () => null });
    expect(res.chunks).toEqual([
      { kind: "reasoning", text: "because" },
      { kind: "text", text: "answer" },
    ]);
  });

  it("halts at the backstop when the model never stops calling tools", async () => {
    const loopingCall: ToolCall = { id: "x", name: "spin", arguments: {} };
    // infer ALWAYS returns a tool call → only the backstop can end it.
    const infer: AgenticDeps["infer"] = async () => callTurn("again", [loopingCall]);
    const res = await runAgenticLoop([{ role: "user", content: "go" }], {
      infer,
      dispatch: async () => "spun",
      maxRounds: 3,
    });
    expect(res.haltedByBackstop).toBe(true);
    expect(res.rounds).toBe(3);
    expect(res.text).toBe("again"); // most recent assistant text
    // 3 rounds × (text + tool_call + tool_result) = 9 chunks.
    expect(res.chunks).toHaveLength(9);
  });

  it("defaults to the generous backstop when maxRounds is unset", async () => {
    let calls = 0;
    const infer: AgenticDeps["infer"] = async () => {
      calls += 1;
      return callTurn("", [{ id: "x", name: "spin", arguments: {} }]);
    };
    const res = await runAgenticLoop([{ role: "user", content: "go" }], { infer, dispatch: async () => null });
    expect(res.haltedByBackstop).toBe(true);
    expect(res.rounds).toBe(DEFAULT_AGENTIC_MAX_ROUNDS);
    expect(calls).toBe(DEFAULT_AGENTIC_MAX_ROUNDS);
  });

  it("handles a call with no id (string result passes through unstringified)", async () => {
    const call: ToolCall = { name: "ping", arguments: {} };
    const { infer, seen } = scriptedInfer([callTurn("", [call]), finalTurn("pong")]);
    const res = await runAgenticLoop([{ role: "user", content: "ping?" }], { infer, dispatch: async () => "alive" });
    expect(res.chunks).toEqual([
      { kind: "tool_call", tool: "ping", arguments: {} }, // no id field
      { kind: "tool_result", tool: "ping", result: "alive" },
      { kind: "text", text: "pong" },
    ]);
    expect(seen[1]).toEqual([
      { role: "user", content: "ping?" },
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", content: "alive", toolCallId: undefined },
    ]);
  });
});
