/**
 * Test helper — a Map-backed {@link InferCache} seeded by the exact content key the
 * `InferStore` mints: `JSON.stringify([model, prompt, schema, cacheKey])`. Replaces
 * the old `cache.upsertTask(...).result = new InferenceResult(...)` pre-seeding now
 * that the synced task plane is gone: a content hit replays the seeded completion
 * with NO backend call, so a test can pin "what a given (infer …) resolves to"
 * without standing up a model.
 *
 * NOT a `.test.ts` file, so vitest's include glob never runs it as a suite.
 */
import type { InferCache } from "@here.build/arrival-inference";
import type { Completion } from "@here.build/arrival-inference";

/** Build the content key for a `(infer model prompt schema cache-key)` call.
 *  Omitted schema / cache-key are `null` (the `#f` lowering). */
export const inferKey = (
  model: string,
  prompt: string,
  schema: string | null = null,
  cacheKey: string | null = null,
): string => JSON.stringify([model, prompt, schema, cacheKey]);

/** An `InferCache` whose `read` replays seeded completions by content key (built via
 *  {@link inferKey}). A miss returns `undefined` → the store falls through to its
 *  router, so seed every key a test expects to resolve offline. */
export const seededCache = (entries: Record<string, unknown>): InferCache => ({
  async read(contentKey: string): Promise<Completion | undefined> {
    return contentKey in entries ? { value: entries[contentKey] } : undefined;
  },
  async write() {},
});
