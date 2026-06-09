/**
 * The CONTENT-affecting model parameters an author binds to an `(llm …)` entity via
 * `(llm/with … :temperature … :system …)`. Distinct from `maxTokens` (an EXECUTION bound,
 * excluded from the cache key): each of these CHANGES the completion, so it folds into the
 * inference's content/cache key (the agentic + cache layers include them, like `tools`).
 * Cross-provider + semantic by design — provider-specific knobs (`frequency_penalty`,
 * `top_k`) are deliberately out of scope. The typed key set is also what the `llm/with`
 * validator checks against (an unknown `:keyword` is a legible error, not a silent no-op).
 */
export interface LlmParams {
  /** Sampling temperature. Lower = more deterministic; omitted ⇒ the endpoint default. */
  temperature?: number;
  /** A model-bound system instruction (the `persona` tier of the merged system prompt). */
  system?: string;
}

/** Runtime descriptor of {@link LlmParams} keys → their expected value type, for the
 *  `(llm/with …)` validator: an unknown `:keyword` or a wrong-typed value is a legible
 *  error, not a silent no-op (the typed-not-bag guarantee). `satisfies` keeps this table in
 *  lockstep with `LlmParams` — add a param to the interface without listing it here and the
 *  compiler complains, so the validator can never drift from the type. */
export const LLM_PARAM_TYPES = {
  temperature: "number",
  system: "string",
} as const satisfies Record<keyof LlmParams, "number" | "string">;

export interface ModelSpec extends LlmParams {
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
  /**
   * Tools the model may call during this inference — the neutral, provider-agnostic
   * shape each {@link ModelBackend} lowers to its provider's tool format. Different
   * tools can change the completion, so the agentic loop includes them in the
   * inference's content/effect key (unlike `maxTokens`, which is excluded). Absent ⇒
   * a plain one-shot completion (no tool-calling).
   */
  tools?: ToolDescriptor[];
}

/**
 * A tool the model may call — the neutral, provider-agnostic descriptor each
 * {@link ModelBackend} lowers to its provider's tool format (OpenAI `function`,
 * Anthropic `tool`). `inputSchema` is JSON Schema (the same `tagToJsonSchema`
 * lowering the output schema uses, so a tool schema can't drift from the wire). An
 * MCP `McpToolDescriptor` maps to this, dropping MCP-only annotations (which feed
 * the non-idempotent lint, not the model).
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * A tool call the model emitted — neutral across providers. `id` matches the
 * eventual tool_result back to this call (OpenAI `tool_call_id`, Anthropic
 * `tool_use` id). `arguments` is the parsed argument object. The agentic loop
 * dispatches `{name, arguments}` across the MCP membrane and appends the result
 * keyed by `id`.
 */
export interface ToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

/**
 * One unit of an inference's trajectory — the normalized, semantic record that
 * accumulates on the rich response (`InferString.chunks`, external-only side-data).
 * Built from the backend's streamed/returned parts: assistant text, reasoning, the
 * model's tool calls, and the tool results fed back. The drift / what-if research
 * computes over the `tool_call` chunks (what the model saw); the raw-vs-post-
 * interception distinction lives in the effect-log, not here.
 */
export type Chunk =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; id?: string; server?: string; tool: string; arguments: unknown }
  | { kind: "tool_result"; id?: string; tool: string; result: unknown };

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
  /**
   * Tool calls the model emitted this turn (neutral shape; each backend lifts them
   * from its provider format). Present ⇒ the agentic loop dispatches them and
   * re-infers with the results; absent ⇒ `value` is the final answer. A plain
   * `(infer …)` with no tools never sees this.
   */
  toolCalls?: ToolCall[];
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
