/**
 * Structural scope identity off an arrival-scheme AST `Pair` — `headOf` (the head
 * symbol name) and `scopeId` (`head@line:col`). Pure, dependency-free leaf.
 *
 * Lives on its own so BOTH `trace-to-forest` (which consumes the live trace) and
 * `trace-snapshot` (which projects a clone-safe payload) can read scope identity
 * without an import cycle — `trace-to-forest` already imports `trace-snapshot`, so
 * `trace-snapshot` cannot import scope logic back through it. Keeping this a leaf
 * also lets the ELK worker (A2) import `scopeId` for the off-thread region build
 * without dragging in `trace-to-forest`'s machinery.
 */

/** Head symbol name of a form: the `__name__` of its `car`, or `"?"` if absent. */
export function headOf(node: unknown): string {
  const car = (node as { car?: { __name__?: unknown } } | null)?.car;
  const name = (car as { __name__?: unknown } | undefined)?.__name__;
  return typeof name === "string" ? name : "?";
}

/** Stable structural scope id: `head@line:col` (or `head` if unlocated). The
 *  parser stamps a `__location__` symbol on located Pairs. Exported so the
 *  unified flow-graph builder can bridge causal-chart nodes (keyed by Pair
 *  identity) back to forest boxes (keyed by this id) — both group by the same
 *  Pair, so the strings coincide.
 *
 *  Note the `__location__` is a SYMBOL-keyed property: it survives on the live
 *  Pair but `structuredClone` strips it. Anything crossing a worker boundary must
 *  pre-derive this string while the live Pair is in hand (see `trace-snapshot`'s
 *  `scope` field), not call `scopeId` on a cloned node. */
export function scopeId(node: unknown): string {
  const head = headOf(node);
  if (node && typeof node === "object") {
    for (const s of Object.getOwnPropertySymbols(node)) {
      if (s.description === "__location__") {
        const loc = (node as Record<symbol, unknown>)[s] as { line?: number; col?: number } | undefined;
        if (loc && typeof loc.line === "number") return `${head}@${loc.line}:${loc.col ?? 0}`;
      }
    }
  }
  return head;
}
