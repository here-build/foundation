export interface ModelSpec {
  model: string;
  prompt: string;
  schema: string | null;
  /**
   * Hard ceiling on generated (completion) tokens for this call. An EXECUTION
   * bound, not content: it caps spend so `actual ≤ quote` by construction (the
   * shared inference plane sets it from the wallet reservation), and it is
   * DELIBERATELY excluded from the content/cache key — `[model, prompt, schema,
   * cacheKey]` — so changing a cap never busts a cached result (identical
   * content yields the identical completion regardless of the ceiling). When a
   * backend was constructed with its own default cap, the per-call `maxTokens`
   * overrides it; omit to use the backend default / provider maximum.
   */
  maxTokens?: number;
}

/** Token counts for one inference, as the provider reports them. The stable
 *  fact we persist; a *reference* dollar cost is derived later via a (volatile)
 *  price map. Distinct from that derived reference cost is the provider's own
 *  settled charge for this call (`providerCostMicroUsd`) — an immutable fact
 *  frozen at call-time, present only when the provider reports it. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * The provider's OWN reported dollar charge for this call, in integer
   * micro-USD (1 USD = 1_000_000), frozen at response time. This is the
   * settled fact resale billing charges against (charge = cost × 1.05) — NOT
   * the volatile `referenceCost` derived from `pricing.ts` (that map estimates
   * "what this would cost hosted" for cost ROI / display; this is what the
   * provider actually billed). Only OpenRouter-shaped responses carry a cost
   * (`usage.cost`, a USD float → micro-USD here); direct OpenAI/Anthropic and
   * local/self-hosted backends omit it (they bill on `referenceCost` or $0).
   * `number` (not `bigint`) to stay a sibling of the token counts and survive
   * the `JSON.stringify` the disk cache does on a `Completion`; the host
   * billing layer narrows to `bigint` at the DB/API edge.
   */
  providerCostMicroUsd?: number;
}

/**
 * The result of one inference: the value plus the usage the provider reported.
 * Every real LLM response carries usage; `usage` is optional only because a
 * backend may genuinely not have it (a pure stub, or a provider that omits it),
 * in which case the call contributes zero to cost accounting.
 */
export interface Completion {
  value: unknown;
  usage?: TokenUsage;
}

/** Receives each streamed text chunk as it arrives. */
export type DeltaSink = (delta: string) => void;

/**
 * An out-of-band streaming event — NOT response text. Today the only kind is a
 * rate-limit pause: the backend hit a 429/503 and is waiting before retrying, so
 * a consumer can surface "this is taking longer than usual" instead of looking
 * hung. It is liveness, not a knob — the author still never models rate limiting.
 */
export interface StreamNotice {
  kind: "rate-limited";
  /** 1-based retry attempt about to be awaited. */
  attempt: number;
  /** How long the pause before this retry will be (ms). */
  delayMs: number;
  /** The HTTP status that triggered the pause (429 / 503). */
  status: number;
}

/** Receives an out-of-band streaming notice (e.g. a rate-limit pause). */
export type NoticeSink = (notice: StreamNotice) => void;

/**
 * The actual inference backend. The kernel never calls this directly —
 * a worker does, exactly once per content tuple, on a cache miss.
 */
export interface ModelBackend {
  complete(spec: ModelSpec): Promise<Completion>;
  /**
   * Stream the completion: call `onDelta` per text chunk, resolve with the
   * final `Completion` (parsed value + usage). `signal` aborts the underlying
   * request (the consumer aborts when its last subscriber drops). `onNotice`
   * (optional) receives out-of-band events like a rate-limit pause, so a
   * consumer can show liveness during a wait. Optional — callers that need
   * streaming fall back to a one-shot `complete` (a single synthetic delta of
   * the whole value) when a backend doesn't implement it.
   */
  stream?(spec: ModelSpec, onDelta: DeltaSink, signal?: AbortSignal, onNotice?: NoticeSink): Promise<Completion>;
}
