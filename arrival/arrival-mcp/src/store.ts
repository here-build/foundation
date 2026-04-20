/**
 * Pluggable async store for arrival MCP interactions.
 *
 * Records every tool call — intent, arguments, result, errors.
 * Failed invocations (phantoms) are interactions with success=false,
 * queryable separately for custdev analysis.
 *
 * Implementations:
 * - InMemorySessionStore (tests)
 * - PostgresSessionStore (production, future)
 */

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** MCP client name, e.g. "claude-ai", "chatgpt", "cursor" */
  clientName?: string;
  /** MCP client/SDK version */
  clientVersion?: string;
  /** Model identifier if known, e.g. "gpt-oss-120b-heretic-v2" */
  modelId?: string;
  /** Raw user-agent header */
  userAgent?: string;
  /** Client IP */
  ip?: string;
  /** Accumulated counters (updated on queries, not guaranteed real-time) */
  interactionCount: number;
  phantomCount: number;
}

export type ErrorType = "validation" | "runtime" | "eval" | "parse" | "unknown_action" | "timeout";

export interface InteractionRecord {
  id: string;
  sessionId: string;
  timestamp: number;
  /** Tool name: "project-discovery", "project-editing", etc. */
  tool: string;
  /** Natural language intent — what the model was trying to accomplish */
  intent?: string;
  /** Full tool arguments (for replay/analysis) */
  arguments: Record<string, unknown>;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Truncated result for review (not full payload) */
  resultSummary?: string;
  /** Execution wall time */
  durationMs: number;
  /** Error classification (when success=false) */
  errorType?: ErrorType;
  /** Error message (when success=false) */
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
