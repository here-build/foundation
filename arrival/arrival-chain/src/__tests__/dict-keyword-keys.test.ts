/**
 * `(dict :tagline t)` — keyword keys are symmetric with `(:tagline obj)` access.
 *
 * A keyword accessor evaluates to a pluck function whose valueOf() is ":tagline";
 * `dict` (project.ts dictKey) recovers the bare field name, so construction and
 * access use the same `:key` token, and templates ({{tagline}}) still resolve.
 * Plain string keys are untouched (backward compatible).
 */
import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "../runner.js";
import { singletonRouter } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";

const router = () => singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "x" })) });
const run = (scm: string) => runPipeline({ files: { "main.scm": scm }, entry: "main.scm", router: router() });

describe("dict keyword keys", () => {
  it("(dict :k v) round-trips via :k AND the bare string key", async () => {
    expect(await run(`(define d (dict :tagline "hi" :reached "x")) (list (:tagline d) (field d "tagline") (:reached d))`))
      .toEqual(["hi", "hi", "x"]);
  });
  it("plain string keys still work", async () => {
    expect(await run(`(:tagline (dict "tagline" "hi"))`)).toBe("hi");
  });
  it("mixes string and keyword keys", async () => {
    expect(await run(`(define d (dict "a" 1 :b 2)) (list (:a d) (:b d))`)).toEqual([1, 2]);
  });
});
