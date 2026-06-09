/**
 * D3 increment 2a — an `(llm …)` entity in the infer path, OBSERVE-ONLY (V's chosen
 * direction). A plain `(infer …)` / `(infer/chat …)` accepts an llm entity wherever a model
 * string goes; the entity's `derive`d middleware runs around the model call as observe-only:
 *
 *   - the model is ALWAYS called with the ORIGINAL request — a middleware's request rewrite
 *     never reaches it (the cache-neutral guarantee: the effective model is the bare name,
 *     which is already the cache key);
 *   - a middleware MAY observe the request, observe/transform the response, short-circuit
 *     with a canned value, or `mcp/break` — but break on a single infer is a legible error
 *     (break belongs to the agentic loop, which has something to halt).
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import type { Completion, ModelBackend, ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { StaticRouter } from "../registry.js";

const rootWith = (backend: ModelBackend) => {
  const root = ArrivalChain.bootstrap(new Project()).root;
  root.bindInfer(createInferStore(new StaticRouter({ mock: backend })));
  return root;
};

interface RecordedCall {
  model: string;
  prompt: string;
  temperature?: number;
  system?: string;
}

/** A backend that echoes a fixed answer and records what reached it on the ModelSpec —
 *  model/prompt (the observe-only contract) plus temperature/system (the tweaks contract). */
function recordingBackend(answer = "ANSWER"): { backend: ModelBackend; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const backend: ModelBackend = {
    async complete(spec: ModelSpec): Promise<Completion> {
      calls.push({ model: spec.model, prompt: spec.prompt, temperature: spec.temperature, system: spec.system });
      return { value: answer };
    },
  };
  return { backend, calls };
}

describe("(llm …) in the infer path — observe-only", () => {
  it('bare (llm "mock") routes to the named model — entity = model-string sugar', async () => {
    const { backend, calls } = recordingBackend();
    const v = await rootWith(backend).run(`(car (infer (llm "mock") "hi"))`);
    expect(v).toBe("ANSWER");
    expect(calls).toEqual([{ model: "mock", prompt: "hi" }]);
  });

  it("a request-rewriting middleware does NOT reach the model (cache-neutral guarantee)", async () => {
    const { backend, calls } = recordingBackend();
    const scm = `(car (infer (derive (llm "mock") :infer (lambda (req next progress) (next "REWRITTEN"))) "original"))`;
    const v = await rootWith(backend).run(scm);
    expect(v).toBe("ANSWER");
    expect(calls).toEqual([{ model: "mock", prompt: "original" }]); // rewrite dropped; model saw the original
  });

  it("a middleware may observe/transform the RESPONSE (response shaping is allowed)", async () => {
    const { backend } = recordingBackend("base");
    const scm = `(car (infer (derive (llm "mock") :infer (lambda (req next progress) (string-append "wrapped:" (next req)))) "hi"))`;
    expect(await rootWith(backend).run(scm)).toBe("wrapped:base");
  });

  it("the middleware observes the request payload as its reqView (the prompt)", async () => {
    const { backend, calls } = recordingBackend();
    // returns the observed request, never calling next → proves reqView = the prompt, model untouched
    const scm = `(car (infer (derive (llm "mock") :infer (lambda (req next progress) req)) "the-prompt"))`;
    expect(await rootWith(backend).run(scm)).toBe("the-prompt");
    expect(calls).toHaveLength(0); // short-circuited — the model was never called
  });

  it("mcp/break from an llm middleware on a single (infer …) is a legible error", async () => {
    const { backend } = recordingBackend();
    const scm = `(car (infer (derive (llm "mock") :infer (lambda (req next progress) mcp/break)) "hi"))`;
    await expect(rootWith(backend).run(scm)).rejects.toThrow(/break only halts an agentic run/);
  });

  it("a non-llm entity (an (mcp …) server) in model position is a legible error", async () => {
    const { backend } = recordingBackend();
    await expect(rootWith(backend).run(`(car (infer (mcp "srv") "hi"))`)).rejects.toThrow(/must be an \(llm …\)/);
  });

  it("(infer/chat (llm …) …) routes through the chain too", async () => {
    const { backend, calls } = recordingBackend("chat-answer");
    const scm = `(car (infer/chat (derive (llm "mock") :infer (lambda (req next progress) (next req))) (list (list "user" "yo"))))`;
    expect(await rootWith(backend).run(scm)).toBe("chat-answer");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("mock");
  });
});

describe("llm/with tweaks reach the model + the cache key (end to end)", () => {
  it("temperature + system land on the ModelSpec the backend sees", async () => {
    const { backend, calls } = recordingBackend();
    const scm = `(car (infer (llm/with (llm "mock") :temperature 0.7 :system "be terse") "hi"))`;
    expect(await rootWith(backend).run(scm)).toBe("ANSWER");
    expect(calls).toEqual([{ model: "mock", prompt: "hi", temperature: 0.7, system: "be terse" }]);
  });

  it("a different temperature busts the cache key (a different completion) — two backend calls", async () => {
    const { backend, calls } = recordingBackend();
    // two infers in one run: same prompt+model, different temperature ⇒ distinct keys ⇒ 2 calls.
    const scm = `(begin
      (infer (llm/with (llm "mock") :temperature 0.2) "hi")
      (infer (llm/with (llm "mock") :temperature 0.9) "hi"))`;
    await rootWith(backend).run(scm);
    expect(calls.map((c) => c.temperature)).toEqual([0.2, 0.9]);
  });

  it("the SAME temperature is one cache key — a single backend call (params are cache-honest)", async () => {
    const { backend, calls } = recordingBackend();
    const scm = `(begin
      (infer (llm/with (llm "mock") :temperature 0.2) "hi")
      (infer (llm/with (llm "mock") :temperature 0.2) "hi"))`;
    await rootWith(backend).run(scm);
    expect(calls).toHaveLength(1); // identical identity ⇒ single-flight cell ⇒ one call
  });

  it("a plain (infer …) with no params is unchanged — no temperature/system on the spec", async () => {
    const { backend, calls } = recordingBackend();
    await rootWith(backend).run(`(car (infer "mock" "hi"))`);
    expect(calls).toEqual([{ model: "mock", prompt: "hi", temperature: undefined, system: undefined }]);
  });
});
