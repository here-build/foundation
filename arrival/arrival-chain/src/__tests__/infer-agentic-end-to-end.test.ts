/**
 * W2 — `(infer/agentic/end-to-end …)` end to end: the capstone that ties the getter +
 * resolveTools + W1's tool-infer + the MCP dispatch + the loop driver into one verb.
 *
 * Proves the honest-tools flow (flow 1): the model emits a tool call → the loop dispatches
 * it across the MCP resolver → feeds the result back → the model finalizes. One verb, real
 * loop, real dispatch. (Middleware/derive — flows 2–4 — land with C3.)
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { Completion, ModelBackend, ModelSpec, ToolDescriptor } from "../model.js";
import type { McpEffect, McpEffectResolver } from "../mcp-effects.js";
import { Project } from "../project.js";
import { StaticRouter } from "../registry.js";

const freshRoot = (backend: ModelBackend) => {
  const root = ArrivalChain.bootstrap(new Project()).root;
  root.bindInfer(createInferStore(new StaticRouter({ mock: backend })));
  return root;
};

/** A resolver that lists one `ping` tool and echoes tool/call args. Records every effect. */
function pingResolver(): { resolve: McpEffectResolver; effects: McpEffect[] } {
  const effects: McpEffect[] = [];
  const resolve: McpEffectResolver = async (_ctx, effect) => {
    effects.push(effect);
    if (effect.method === "tools/list") {
      return { tools: [{ name: "ping", description: "pong machine", inputSchema: { type: "object" } }] };
    }
    if (effect.method === "tools/call") return { pong: (effect.request as { args: unknown }).args };
    throw new Error(`unexpected method ${effect.method}`);
  };
  return { resolve, effects };
}

describe("infer/agentic/end-to-end — honest-tools flow (end to end)", () => {
  it("drives a turn: model calls a tool → dispatch → feed back → model finalizes", async () => {
    const seenTools: (ToolDescriptor[] | undefined)[] = [];
    let turn = 0;
    const backend: ModelBackend = {
      async complete(spec: ModelSpec): Promise<Completion> {
        turn += 1;
        seenTools.push(spec.tools);
        // Turn 1: call the tool. Turn 2 (after the tool result is fed back): finalize.
        return turn === 1
          ? { value: "", toolCalls: [{ id: "c1", name: "ping", arguments: { x: 1 } }] }
          : { value: "all done" };
      },
    };
    const { resolve, effects } = pingResolver();

    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end "mock" (list (list "user" "ping the server")) (list (mcp "srv"))))`,
      { mcp: resolve },
    );

    expect(value).toBe("all done"); // the final answer (InferString → bare string)
    expect(turn).toBe(2); // two inference turns: call, then finalize
    // The tool set was sent to the model on the first turn (W1 threads spec.tools).
    expect(seenTools[0]?.map((t) => t.name)).toEqual(["ping"]);
    // Effects in order: tools/list (discovery), then tools/call (the dispatch).
    expect(effects.map((e) => e.method)).toEqual(["tools/list", "tools/call"]);
    expect(effects[1]).toMatchObject({
      method: "tools/call",
      server: "srv",
      request: { tool: "ping", args: { x: 1 } }, // the model's args routed through verbatim
    });
  });

  it("finalizes in one turn when the model uses no tools (loop degenerates cleanly)", async () => {
    const backend: ModelBackend = { complete: vi.fn(async () => ({ value: "no tools needed" })) };
    const { resolve, effects } = pingResolver();

    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end "mock" (list (list "user" "just answer")) (list (mcp "srv"))))`,
      { mcp: resolve },
    );

    expect(value).toBe("no tools needed");
    expect(backend.complete).toHaveBeenCalledTimes(1); // one shot
    expect(effects.map((e) => e.method)).toEqual(["tools/list"]); // discovery only, no dispatch
  });

  it("rejects when the model calls a tool outside the :tools set (legible error)", async () => {
    const backend: ModelBackend = {
      async complete(): Promise<Completion> {
        return { value: "", toolCalls: [{ id: "c1", name: "not_a_tool", arguments: {} }] };
      },
    };
    const { resolve } = pingResolver();

    await expect(
      freshRoot(backend).run(
        `(car (infer/agentic/end-to-end "mock" (list (list "user" "go")) (list (mcp "srv"))))`,
        { mcp: resolve },
      ),
    ).rejects.toThrow(/unknown tool "not_a_tool"/);
  });

  it("flow 4: a derived mcp/break middleware HALTS the loop, suppressing the call", async () => {
    let turns = 0;
    const backend: ModelBackend = {
      async complete(): Promise<Completion> {
        turns += 1;
        // Turn 1 calls the tool; the break middleware suppresses it + halts (no turn 2).
        return { value: "let me check", toolCalls: [{ id: "c1", name: "ping", arguments: {} }] };
      },
    };
    const { resolve, effects } = pingResolver();

    // derive a tools/call middleware that returns mcp/break (capture + suppress + halt).
    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end "mock"
              (list (list "user" "ping then stop"))
              (list (mcp/derive (mcp "srv") :tools/call (lambda (req next progress) mcp/break)))))`,
      { mcp: resolve },
    );

    expect(value).toBe("let me check"); // the assistant text on the breaking turn (lastText)
    expect(turns).toBe(1); // loop halted after the break — no second inference
    // tools/list fired (discovery), but tools/call NEVER reached the honest resolver (break suppressed it).
    expect(effects.map((e) => e.method)).toEqual(["tools/list"]);
  });
});
