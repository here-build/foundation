export interface ModelSpec {
  model: string;
  prompt: string;
  schema: string | null;
}

/** Token counts for one inference, as the provider reports them. The stable
 *  fact we persist; dollar cost is derived later via a (volatile) price map. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
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

/**
 * The actual inference backend. The kernel never calls this directly —
 * a worker does, exactly once per content tuple, on a cache miss.
 */
export interface ModelBackend {
  complete(spec: ModelSpec): Promise<Completion>;
}
