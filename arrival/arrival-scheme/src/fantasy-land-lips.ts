/**
 * Fantasy Land for LIPS Classes — RETIRED MONKEY-PATCH (now a no-op).
 *
 * Historically this module `Object.assign`ed Fantasy Land methods (Functor
 * `map`, Filterable `filter`, Foldable `reduce`, Traversable `traverse`,
 * Chain `chain`, Applicative `of`) onto `Pair.prototype` and
 * `SchemeString.prototype` at runtime via `applyFantasyLandPatches()`.
 *
 * As of the algebras-in-entities migration (wave 2,
 * plan-2026-06-10-algebras-in-entities.md) those algebras live IN the class
 * bodies (Pair.ts / LString.ts) — declared once, alongside Setoid/Ord. The
 * `chainPair` circular-dep hack (`require("./lips").global_env.get("append")`)
 * dissolved: `chain` now flattens through the PURE list-concat Semigroup on
 * Pair, with no back-edge into lips.ts.
 *
 * `applyFantasyLandPatches` is kept as an exported no-op so its two callers —
 * `src/index.ts` (module init) and `src/__tests__/clone-identity.test.ts`
 * (which re-triggers it defensively before asserting FL behavior on
 * `Pair.prototype`) — keep compiling. The FL behavior they assert now comes
 * from the class bodies, so the no-op is correct: the methods are already
 * present on the prototype at class-definition time.
 */

export function applyFantasyLandPatches(): void {
  // No-op. Fantasy Land structure-algebras now live in the class bodies
  // (Pair.ts, LString.ts). See the module doc-comment above.
}
