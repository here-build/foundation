export interface ModelSpec {
  model: string;
  prompt: string;
  schema: string | null;
}

/**
 * The actual inference backend. The kernel never calls this directly —
 * a worker does, exactly once per content tuple, on a cache miss.
 */
export interface ModelBackend {
  complete(spec: ModelSpec): Promise<unknown>;
}
