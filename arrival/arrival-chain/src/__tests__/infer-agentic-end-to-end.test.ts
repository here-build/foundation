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
import { createInferStore } from "@here.build/arrival-inference";
import type { Completion, ModelBackend, ModelSpec, ToolDescriptor } from "@here.build/arrival-inference";
import type { McpEffect, McpEffectResolver } from "../mcp-effects.js";
import { Project } from "../project.js";
import { StaticRouter } from "@here.build/arrival-inference";

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
              (list (derive (mcp "srv") :tools/call (lambda (req next progress) mcp/break)))))`,
      { mcp: resolve },
    );

    expect(value).toBe("let me check"); // the assistant text on the breaking turn (lastText)
    expect(turns).toBe(1); // loop halted after the break — no second inference
    // tools/list fired (discovery), but tools/call NEVER reached the honest resolver (break suppressed it).
    expect(effects.map((e) => e.method)).toEqual(["tools/list"]);
  });

  it("a budget-terminator middleware reads progress.round and halts past a threshold", async () => {
    let turns = 0;
    const backend: ModelBackend = {
      async complete(): Promise<Completion> {
        turns += 1;
        return { value: "still going", toolCalls: [{ id: "c", name: "ping", arguments: {} }] }; // never stops on its own
      },
    };
    const { resolve, effects } = pingResolver();

    // derive a tools/call middleware that breaks once round > 2 (reads the loop's progress).
    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end "mock"
              (list (list "user" "loop forever"))
              (list (derive (mcp "srv") :tools/call
                      (lambda (req next progress)
                        (if (> (@ progress "round") 2) mcp/break (next req)))))))`,
      { mcp: resolve },
    );

    expect(value).toBe("still going");
    expect(turns).toBe(3); // rounds 1,2 dispatched honestly; round 3 the budget broke
    // discovery + two honest tools/call (rounds 1,2); round 3 broke BEFORE honest.
    expect(effects.map((e) => e.method)).toEqual(["tools/list", "tools/call", "tools/call"]);
  });

  it("C6: a .prompt with `mcp:` frontmatter runs AGENTICALLY (agent-as-a-file)", async () => {
    let turns = 0;
    const backend: ModelBackend = {
      async complete(): Promise<Completion> {
        turns += 1;
        return turns === 1
          ? { value: "", toolCalls: [{ id: "c1", name: "ping", arguments: { n: 1 } }] }
          : { value: "agent done" };
      },
    };
    const { resolve, effects } = pingResolver();
    const root = freshRoot(backend);
    root.addFile("agent.prompt", `---\nmodel: mock\nmcp: srv\n---\n{{role "user"}}\nping the server then answer`);

    // require the .prompt → a sealed proc; calling it runs the agentic loop, not one infer.
    const value = await root.run(`(define agent (require "agent.prompt")) (agent "k")`, { mcp: resolve });

    expect(value).toBe("agent done"); // the final answer (loop ran to completion)
    expect(turns).toBe(2); // call turn + finalize turn
    expect(effects.map((e) => e.method)).toEqual(["tools/list", "tools/call"]); // discovery + dispatch
  });

  it("C6: a .prompt combining mcp: with output: (schema) is a legible v1 error", async () => {
    const root = freshRoot({ complete: vi.fn(async () => ({ value: "x" })) });
    root.addFile("bad.prompt", `---\nmodel: mock\nmcp: srv\noutput:\n  answer: string\n---\n{{role "user"}}\nhi`);
    await expect(root.run(`(define a (require "bad.prompt")) (a "k")`, { mcp: pingResolver().resolve })).rejects.toThrow(
      /structured agentic output is not supported/,
    );
  });
});

describe("D3 incr 2b — an (llm …) entity as the agentic model (observe-only per turn)", () => {
  it("a pass-through (llm …) middleware PRESERVES the loop's toolCalls (InferString not demoted)", async () => {
    // THE correctness test: if a scheme middleware's return drove the loop, turn 1's
    // InferString would round-trip through lipsToJs, demote to a bare string, and lose its
    // toolCalls — the loop would finalize on turn 1. Driving on the captured raw InferString
    // keeps the calls, so the tool turn still dispatches.
    let turn = 0;
    const backend: ModelBackend = {
      async complete(): Promise<Completion> {
        turn += 1;
        return turn === 1
          ? { value: "", toolCalls: [{ id: "c1", name: "ping", arguments: { x: 1 } }] }
          : { value: "done" };
      },
    };
    const { resolve, effects } = pingResolver();
    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end
              (derive (llm "mock") :infer (lambda (req next progress) (next req)))
              (list (list "user" "ping then answer"))
              (list (mcp "srv"))))`,
      { mcp: resolve },
    );
    expect(value).toBe("done");
    expect(turn).toBe(2); // tool turn + finalize — the toolCalls survived the middleware
    expect(effects.map((e) => e.method)).toEqual(["tools/list", "tools/call"]);
  });

  it("an (llm …) budget middleware reads progress.round and halts the loop (per-inference break)", async () => {
    let turn = 0;
    const backend: ModelBackend = {
      async complete(): Promise<Completion> {
        turn += 1;
        return { value: `round ${turn}`, toolCalls: [{ id: "c", name: "ping", arguments: {} }] }; // never stops itself
      },
    };
    const { resolve } = pingResolver();
    // Break the INFERENCE once round > 2 — before the model is called on round 3.
    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end
              (derive (llm "mock") :infer
                (lambda (req next progress) (if (> (@ progress "round") 2) mcp/break (next req))))
              (list (list "user" "loop"))
              (list (mcp "srv"))))`,
      { mcp: resolve },
    );
    expect(turn).toBe(2); // rounds 1,2 inferred; round 3 broke before the model call
    expect(value).toBe("round 2"); // the prior turn's text (the broken round produced none)
  });

  it("a bare (llm …) model in the agentic verb works (= string model)", async () => {
    const backend: ModelBackend = { complete: vi.fn(async () => ({ value: "no tools needed" })) };
    const { resolve, effects } = pingResolver();
    const value = await freshRoot(backend).run(
      `(car (infer/agentic/end-to-end (llm "mock") (list (list "user" "answer")) (list (mcp "srv"))))`,
      { mcp: resolve },
    );
    expect(value).toBe("no tools needed");
    expect(effects.map((e) => e.method)).toEqual(["tools/list"]); // discovery only
  });
});
