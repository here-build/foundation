/**
 * MCP host server-tape — positional record / hermetic replay / verification.
 *
 * The MCP client MEMBRANE (the resolver seam, the entity getters, the dispatch verbs, the
 * derive algebra) now lives in `@here.build/arrival-scheme-env-infer` (the inference package
 * — MCP tool use is inference-with-tools). This module keeps only the HOST-SIDE concern that
 * belongs with run orchestration: {@link wrapMcpResolver}, which records each MCP call
 * POSITIONALLY per (inference, server) — not by content like infer/http/sql, because an MCP
 * call's result depends on the server's hidden mutable state (read-after-write). Replay is
 * HERMETIC (returns the recorded reply, NEVER re-fires — so a what-if cannot trigger a second
 * destructive action) and VERIFIES the recorded `{server,method,request}` against the live
 * call, stopping on divergence rather than silently serving a stale value.
 *
 * The membrane + algebra are re-exported below so existing arrival-chain import paths are
 * unchanged.
 */

import { describeMcpEffect, type McpEffect, type McpEffectResolver, type McpMethod } from "@here.build/arrival-scheme-env-infer";

import { mcpEffectKey, stableJson } from "./effect-log.js";

// ── server-tape: positional record / hermetic replay / verification ──────────

/** The recorded tape entry: the reply, plus the `{server,method,request}` verification
 *  record so replay can confirm the nth call aligns with what was recorded. */
export interface McpTapeRecord {
  server: string;
  method: McpMethod;
  request: unknown;
  reply: unknown;
}

/** A replay divergence — the nth call to a server does not match the recorded tape (a
 *  what-if changed the trajectory). Hermetic replay cannot re-fire, so this is a
 *  legitimate STOP: by default throw; a host may instead supply the answer (ask the user
 *  / LLM-simulate) via {@link McpTapeSeam.onDivergence}. */
export interface McpDivergence {
  key: string;
  reason: "mismatch";
  got: McpEffect;
  expected: McpTapeRecord;
}

/** Wiring a server-tape needs: the inference identity it is anchored to, the replay
 *  source (recorded log), the record sink (this run's collector), and a divergence
 *  policy. Mirrors the `{ effectLog, onEffectResult }` seam `Project` threads to data
 *  effects (`#wrapDataResolver`). */
export interface McpTapeSeam {
  /** The inference this tape is anchored to (its cache identity) — the first key element. */
  inferenceId: string;
  /** Replay source: recorded mcp entries (full → hermetic; absent → all live). */
  effectLog?: Map<string, string>;
  /** Called with the positional key for every mcp call as it fires, in order (→
   *  `Run.effects`, the causal key sequence), for fresh AND replayed calls. */
  onEffect?: (effectKey: string) => void;
  /** Record sink for THIS run (→ the effect-log collector). */
  onEffectResult?: (effectKey: string, valueJson: string) => void;
  /** Divergence policy on a verification mismatch. Default: throw a teaching error. A
   *  host may return a substitute reply (ask-user / LLM-simulate) instead. */
  onDivergence?: (divergence: McpDivergence) => Promise<unknown> | unknown;
}

/**
 * Wrap an {@link McpEffectResolver} with positional server-tape record/replay +
 * verification — the MCP twin of `Project.#wrapDataResolver`, but keyed POSITIONALLY
 * (per inference, per server) rather than by content, because MCP calls are stateful.
 *
 *   - LIVE (no recorded entry): call `inner`, record `{server,method,request,reply}`
 *     under the positional key. Order is the run's natural call order — deterministic in
 *     sequential code; a parallel arm is the lint case (racy index reconstruction).
 *   - REPLAY (entry present): VERIFY the recorded `{server,method,request}` matches this
 *     call; on match return the recorded reply WITHOUT calling `inner` (HERMETIC — never
 *     re-fires, so a destructive call cannot run twice); on mismatch raise a divergence.
 *
 * Returns a resolver closure carrying the per-server counter (one tape per server within
 * the inference). One wrap per inference.
 */
export function wrapMcpResolver(inner: McpEffectResolver, seam: McpTapeSeam): McpEffectResolver {
  const nextIndex = new Map<string, number>(); // server → next positional index in this inference
  return async (ctx, effect) => {
    const n = nextIndex.get(effect.server) ?? 0;
    nextIndex.set(effect.server, n + 1);
    const key = mcpEffectKey(seam.inferenceId, effect.server, n);

    const replayed = seam.effectLog?.get(key);
    if (replayed !== undefined) {
      const record = JSON.parse(replayed) as McpTapeRecord;
      if (
        record.server !== effect.server ||
        record.method !== effect.method ||
        stableJson(record.request) !== stableJson(effect.request)
      ) {
        const divergence: McpDivergence = { key, reason: "mismatch", got: effect, expected: record };
        if (seam.onDivergence) return await seam.onDivergence(divergence);
        throw new Error(
          `${describeMcpEffect(effect)}: replay divergence at ${key} — recorded ` +
            `${record.method} on "${record.server}", got ${effect.method} on "${effect.server}". ` +
            `Hermetic replay cannot re-fire an MCP call; re-record this run or supply the ` +
            `expected answer (onDivergence).`,
        );
      }
      // fired for replayed calls too — the key sequence is part of the run's identity.
      seam.onEffect?.(key);
      seam.onEffectResult?.(key, replayed);
      return record.reply;
    }

    // live — call the honest resolver, then record the tape entry.
    seam.onEffect?.(key);
    const reply = await inner(ctx, effect);
    const record: McpTapeRecord = {
      server: effect.server,
      method: effect.method,
      request: effect.request,
      reply: reply ?? null,
    };
    seam.onEffectResult?.(key, JSON.stringify(record));
    return reply;
  };
}

// ── re-exports: the MCP membrane (env-infer) + the derive algebra (arrival-inference) ──
//
// Both relocated out of arrival-chain — the membrane into the inference package, the
// algebra into the engine. Re-exported here so existing `./mcp-effects.js` import paths
// across arrival-chain (and the chain barrel) keep resolving unchanged.

export {
  describeMcpEffect,
  dispatchThroughChain,
  inertMcpResolver,
  type McpEffect,
  type McpEffectResolver,
  type McpMethod,
  resolveTools,
} from "@here.build/arrival-scheme-env-infer";

export {
  DerivableEntity,
  type EntityMiddleware,
  isDerivableEntity,
  isMcpBreak,
  MCP_BREAK,
  type McpDefinedMethod,
  runMiddlewareChain,
} from "@here.build/arrival-inference";
