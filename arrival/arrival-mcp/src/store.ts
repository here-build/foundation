/**
 * Failed invocations (phantoms) are recorded as interactions with `success: false`, queryable
 * separately for custdev analysis — they're data to study, not dropped errors.
 */

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** e.g. "claude-ai", "chatgpt", "cursor" */
  clientName?: string;
  clientVersion?: string;
  /** e.g. "gpt-oss-120b-heretic-v2" */
  modelId?: string;
  userAgent?: string;
  ip?: string;
  /** Updated on queries — not guaranteed real-time. */
  interactionCount: number;
  phantomCount: number;
}

export type ErrorType = "validation" | "runtime" | "eval" | "parse" | "unknown_action" | "timeout";

export interface InteractionRecord {
  id: string;
  sessionId: string;
  timestamp: number;
  /** e.g. "project-discovery", "project-editing" */
  tool: string;
  /** Free-text goal the model stated for the call. */
  intent?: string;
  /** Stored in full, for replay/analysis. */
  arguments: Record<string, unknown>;
  success: boolean;
  /** Truncated — not the full payload. */
  resultSummary?: string;
  durationMs: number;
  /** Both set when `success` is false. */
  errorType?: ErrorType;
  errorMessage?: string;
}

export interface ArrivalSessionStore {
  // ── Session lifecycle ──
  startSession(session: Omit<SessionRecord, "interactionCount" | "phantomCount">): Promise<void>;
  endSession(sessionId: string): Promise<void>;

  // ── Recording ──
  recordInteraction(interaction: InteractionRecord): Promise<void>;

  // ── Queries ──
  getSession(sessionId: string): Promise<SessionRecord | null>;
  getInteractions(sessionId: string): Promise<InteractionRecord[]>;
  /** Query failed interactions. Phantoms are just interactions where success=false. */
  getPhantoms(query?: { tool?: string; errorType?: ErrorType; limit?: number }): Promise<InteractionRecord[]>;
}
