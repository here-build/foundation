/**
 * Typed error kernel for arrival-mcp.
 *
 * Replaces the string-matching error classification in dispatch.ts:58-71. The
 * dispatcher, sanitizers, and tool implementations throw MCPError instances
 * with a discrete `kind`; LLM-facing surfaces inspect `.kind` directly.
 *
 * Per H7: `kind` becomes part of the public API — adding a kind is additive
 * (safe), renaming/removing is a breaking change.
 */

export type MCPErrorKind =
  /** Raw JSON parse of request body failed. */
  | "parse"
  /** Schema validation failed (context / props / action args). */
  | "validation"
  /** Tool's prepare() phase threw. */
  | "prepare"
  /** A phase exceeded its deadline. */
  | "timeout"
  /** Input exceeded a size limit (request body, actions count, field size). */
  | "size-limit"
  /** Tool or action name was not registered. */
  | "unknown-action"
  /** Action's on: receiver didn't match ctx[receiverKey].constructor. */
  | "no-receiver-match"
  /** Action handler threw. */
  | "handler"
  /** Catch-all for genuinely unknown failures. */
  | "runtime";

export interface MCPErrorDetails {
  /** Which phase was executing when the error occurred. */
  phase?: "parse" | "validation" | "prepare" | "handler" | "dispatch" | "cleanup";
  /** Field / action / cluster name for context. */
  target?: string;
  /** Arbitrary extra data for diagnostics. */
  extra?: Record<string, unknown>;
}

export class MCPError extends Error {
  readonly kind: MCPErrorKind;
  readonly details: MCPErrorDetails;

  constructor(kind: MCPErrorKind, message: string, details: MCPErrorDetails = {}) {
    super(message);
    this.name = "MCPError";
    this.kind = kind;
    this.details = details;
    // Preserve original stack through the type discrimination.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MCPError);
    }
  }

  toJSON(): { kind: MCPErrorKind; message: string; details: MCPErrorDetails } {
    return { kind: this.kind, message: this.message, details: this.details };
  }
}

export function isMCPError(e: unknown): e is MCPError {
  return e instanceof MCPError;
}

/**
 * Classify an arbitrary thrown value into an MCPError. Preserves MCPError
 * instances unchanged; wraps everything else as a generic `runtime` error.
 *
 * Use at egress points (dispatch result, adapter response) so LLM-facing
 * surfaces always see typed errors regardless of what internal code threw.
 */
export function classifyError(e: unknown, fallbackKind: MCPErrorKind = "runtime"): MCPError {
  if (isMCPError(e)) return e;
  if (e instanceof Error) {
    return new MCPError(fallbackKind, e.message, {
      extra: { originalName: e.name, stack: e.stack },
    });
  }
  return new MCPError(fallbackKind, String(e));
}

// ─── Timeout helpers ────────────────────────────────────────────────────────

/**
 * Race a promise against a deadline. On timeout, reject with
 * `MCPError("timeout")` tagged with phase + target for diagnostics.
 *
 * Uses AbortSignal when the operation supports it; unrelated in-flight work
 * may still run, but the returned promise resolves promptly on timeout.
 */
export async function withTimeout<T>(
  op: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  phase: MCPErrorDetails["phase"],
  target?: string,
): Promise<T> {
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), deadlineMs);
  try {
    return await Promise.race([
      op(ac.signal),
      new Promise<T>((_resolve, reject) => {
        ac.signal.addEventListener("abort", () => {
          reject(
            new MCPError("timeout", `${phase ?? "operation"} exceeded deadline of ${deadlineMs}ms`, {
              phase,
              target,
              extra: { deadlineMs },
            }),
          );
        });
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Size-limit helpers ─────────────────────────────────────────────────────

export interface SizeLimits {
  /** Max number of actions in a single batch. Default: 50. */
  maxActions?: number;
  /** Max number of fields accepted in a props object. Default: 64. */
  maxPropsFields?: number;
  /** Max string-length of any single string value (context/props). Default: 16384. */
  maxStringFieldSize?: number;
}

export const DEFAULT_SIZE_LIMITS: Required<SizeLimits> = {
  maxActions: 50,
  maxPropsFields: 64,
  maxStringFieldSize: 16_384,
};

export function checkSizeLimit(
  current: number,
  max: number,
  label: string,
  target?: string,
): void {
  if (current > max) {
    throw new MCPError("size-limit", `${label} exceeded: ${current} > ${max}`, {
      target,
      extra: { current, max },
    });
  }
}

export function checkStringSize(
  value: string,
  max: number,
  target?: string,
): void {
  if (value.length > max) {
    throw new MCPError(
      "size-limit",
      `string field "${target ?? "unnamed"}" exceeded ${max} chars: ${value.length}`,
      { target, extra: { length: value.length, max } },
    );
  }
}
