/**
 * The LM Studio connector probe — `/api/v0/models` is both the capability read AND
 * the type detector: that endpoint answering with the `{data:[…]}` shape is the proof
 * it's LM Studio. Everything else (network error, non-200, wrong shape) → `null` =
 * "no LM Studio here", never a throw. We stub `fetch` to drive each branch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { lmStudioRouter, probeLmStudio } from "../connectors/lmstudio.js";

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as unknown as Response;

const stubFetch = (impl: (url: string) => Promise<Response>) => {
  vi.stubGlobal("fetch", vi.fn((url: string) => impl(url)));
};

afterEach(() => vi.unstubAllGlobals());

describe("probeLmStudio — detection + normalization", () => {
  it("normalizes a typical /api/v0/models payload (state, context, type)", async () => {
    stubFetch(async (url) => {
      expect(url).toBe("http://localhost:1234/api/v0/models");
      return jsonResponse({
        data: [
          { id: "qwen2.5-coder-7b", state: "loaded", max_context_length: 32768, type: "llm" },
          { id: "llava-1.5", state: "not-loaded", max_context_length: 4096, type: "vlm" },
        ],
      });
    });
    const status = await probeLmStudio();
    expect(status).toEqual({
      reachable: true,
      models: [
        { id: "qwen2.5-coder-7b", loaded: true, contextWindow: 32768, kind: "llm", capabilities: [] },
        { id: "llava-1.5", loaded: false, contextWindow: 4096, kind: "vlm", capabilities: ["vision"] },
      ],
    });
  });

  it("derives vision from a vlm type and maps explicit capability tokens (de-duped, aliased)", async () => {
    stubFetch(async () =>
      jsonResponse({
        data: [
          { id: "tooly", type: "llm", capabilities: ["function_calling", "tools"] },
          { id: "omni", type: "vlm", capabilities: ["vision", "audio_input"] },
        ],
      }),
    );
    const status = await probeLmStudio();
    expect(status?.models).toEqual([
      { id: "tooly", loaded: false, kind: "llm", capabilities: ["tool_use"] },
      { id: "omni", loaded: false, kind: "vlm", capabilities: ["vision", "audio"] },
    ]);
  });

  it("is tolerant: skips rows without an id, defaults missing type to llm, omits bad context", async () => {
    stubFetch(async () =>
      jsonResponse({
        data: [
          { state: "loaded" }, // no id → dropped
          { id: "bare" }, // no state/type/ctx → loaded:false, kind:llm, no contextWindow
          { id: "weird", type: "something-else", max_context_length: 0 },
        ],
      }),
    );
    const status = await probeLmStudio();
    expect(status?.models).toEqual([
      { id: "bare", loaded: false, kind: "llm", capabilities: [] },
      { id: "weird", loaded: false, kind: "llm", capabilities: [] },
    ]);
  });

  it("honors a custom endpoint", async () => {
    stubFetch(async (url) => {
      expect(url).toBe("http://127.0.0.1:4321/api/v0/models");
      return jsonResponse({ data: [] });
    });
    expect(await probeLmStudio("http://127.0.0.1:4321")).toEqual({ reachable: true, models: [] });
  });

  it("strips a trailing /v1 (the OpenAI-compat base) so both namespaces append cleanly", async () => {
    stubFetch(async (url) => {
      expect(url).toBe("http://localhost:1234/api/v0/models");
      return jsonResponse({ data: [] });
    });
    expect(await probeLmStudio("http://localhost:1234/v1")).toEqual({ reachable: true, models: [] });
  });

  it("strips trailing slashes (bare origin or /v1/ both name the same runtime root)", async () => {
    stubFetch(async (url) => {
      expect(url).toBe("http://localhost:1234/api/v0/models");
      return jsonResponse({ data: [] });
    });
    expect(await probeLmStudio("http://localhost:1234/")).toEqual({ reachable: true, models: [] });
    expect(await probeLmStudio("http://localhost:1234/v1/")).toEqual({ reachable: true, models: [] });
  });

  it("returns null on a network error (LNA-denied / CORS / refused — all indistinguishable)", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await probeLmStudio()).toBeNull();
  });

  it("returns null on a non-200", async () => {
    stubFetch(async () => jsonResponse({ data: [] }, false));
    expect(await probeLmStudio()).toBeNull();
  });

  it("returns null on a wrong-shape body (not the /api/v0 list → not LM Studio)", async () => {
    stubFetch(async () => jsonResponse({ object: "list", things: [] }));
    expect(await probeLmStudio()).toBeNull();
  });

  it("returns null when the body isn't JSON", async () => {
    stubFetch(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) as unknown as Response);
    expect(await probeLmStudio()).toBeNull();
  });
});

describe("lmStudioRouter — probe result → routable transport", () => {
  it("routes every probed model id to a backend, unknown ids → null", async () => {
    const router = lmStudioRouter({
      reachable: true,
      models: [
        { id: "qwen2.5-coder-7b", loaded: true, kind: "llm", capabilities: [] },
        { id: "llava-1.5", loaded: false, kind: "vlm", capabilities: ["vision"] },
      ],
    });
    expect(await router.backendFor("qwen2.5-coder-7b")).not.toBeNull();
    expect(await router.backendFor("llava-1.5")).not.toBeNull();
    expect(await router.backendFor("gpt-4o")).toBeNull(); // not on this machine → falls through
  });

  it("shares ONE transport across all models (one baseURL serves them all)", async () => {
    const router = lmStudioRouter({
      reachable: true,
      models: [
        { id: "a", loaded: true, kind: "llm", capabilities: [] },
        { id: "b", loaded: false, kind: "llm", capabilities: [] },
      ],
    });
    expect(await router.backendFor("a")).toBe(await router.backendFor("b"));
  });
});
