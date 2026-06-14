/**
 * overlayInferStore routes each `(infer …)` to a PRIMARY plane (the user's local
 * $0 models, reached lazily) when that model is served there, else falls through to
 * the FALLBACK (team) plane. The choice is async (a probe) behind a synchronous
 * cell interface, so these tests pin: (1) lazy — no probe until a model is asked;
 * (2) per-model routing; (3) the run-path member set (finished/acquire/done/release)
 * is forwarded to the chosen cell.
 */
import { describe, expect, it, vi } from "vitest";

import type { Completion, ModelSpec } from "../model.js";
import { type InferCell, type InferStoreLike, overlayInferStore } from "../infer-store.js";

const spec = (model: string): ModelSpec => ({ model, prompt: "hi", schema: null });

/** A trivial settled cell tagged with which plane vended it. */
function fakeCell(tag: string): InferCell & { tag: string } {
  let acquired = 0;
  return {
    tag,
    text: () => tag,
    finished: () => true,
    done: Promise.resolve({ value: tag } as unknown as Completion),
    onDelta: () => () => {},
    acquire: () => void (acquired += 1),
    release: () => void (acquired -= 1),
  };
}

/** A store that records every model it's asked for. */
function fakeStore(tag: string): InferStoreLike & { models: string[] } {
  const models: string[] = [];
  return {
    models,
    get(s) {
      models.push(s.model);
      return fakeCell(tag);
    },
  };
}

describe("overlayInferStore", () => {
  it("routes a primary-served model to the primary plane (and never touches fallback)", async () => {
    const primary = fakeStore("local");
    const fallback = fakeStore("team");
    const store = overlayInferStore(async (m) => (m === "qwen" ? primary : null), fallback);

    const cell = store.get(spec("qwen"), null) as InferCell & { tag?: string };
    const done = (await cell.done) as unknown as { value: string };
    expect(done.value).toBe("local");
    expect(primary.models).toEqual(["qwen"]);
    expect(fallback.models).toEqual([]);
  });

  it("falls through to the team plane when the model isn't served locally", async () => {
    const primary = fakeStore("local");
    const fallback = fakeStore("team");
    const store = overlayInferStore(async (m) => (m === "qwen" ? primary : null), fallback);

    const cell = store.get(spec("gpt-4o"), null);
    const done = (await cell.done) as unknown as { value: string };
    expect(done.value).toBe("team");
    expect(primary.models).toEqual([]); // resolvePrimary said null → never .get on primary
    expect(fallback.models).toEqual(["gpt-4o"]);
  });

  it("is lazy: resolvePrimary is not called until backendFor/done is awaited via get", async () => {
    const resolvePrimary = vi.fn(async () => null);
    const fallback = fakeStore("team");
    overlayInferStore(resolvePrimary, fallback); // construct only
    expect(resolvePrimary).not.toHaveBeenCalled();
  });

  it("forwards acquire before the inner cell resolves, then nets onto it", async () => {
    let inner: (InferCell & { acquired: () => number }) | undefined;
    const primary: InferStoreLike = {
      get() {
        let n = 0;
        inner = {
          tag: "local",
          acquired: () => n,
          text: () => "",
          finished: () => false,
          done: Promise.resolve({ value: "local" } as unknown as Completion),
          onDelta: () => () => {},
          acquire: () => void (n += 1),
          release: () => void (n -= 1),
        } as InferCell & { acquired: () => number };
        return inner;
      },
    };
    const store = overlayInferStore(async () => primary, fakeStore("team"));
    const cell = store.get(spec("qwen"), null);
    cell.acquire(); // before the async pick resolves → buffered
    await cell.done; // pick resolves, inner created, buffered acquire applied
    expect(inner?.acquired()).toBe(1);
  });
});
