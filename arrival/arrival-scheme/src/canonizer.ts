// canonizer.ts — the canonizer registry (read side first).
//
// Per docs/working-proposals/arrival-sweet-extension-design-ideation-2026-06-15.md, every authoring
// glyph lowers to a readable verb in the canonical s-expr (the scheme rung uses words, not C-glyphs);
// the human face renders the glyph back. This is the "spelling rows" of the registry. Only the READ
// direction (glyph → verb) is here; the render/emit half is the next phase.
//
// DEFERRED rows (decided, not yet wired):
//   `||` → `or`   — `||` is R7RS pipe-symbol syntax (`|sym|`); needs the glyph lexed before that rule.
//   `=>` → fn     — preferred *fn-expr shape* (V 2026-06-15), but `=>` is a syntax-rules literal in
//                   `cond`, so aliasing it as a value needs the cond interaction resolved first.

import { SchemeSymbol } from "./SchemeSymbol.js";
import type { SchemeValue } from "./types.js";

/** Glyph → readable verb (the spelling rows, read direction). Conflict-free glyphs only. */
export const GLYPH_MAP: Record<string, string> = {
  "&&": "and",
  "==": "equal?",
  "??": "or/maybe",
};

/** Lower a glyph operator to its verb; pass any non-glyph value through unchanged. Run at the
 *  operator position so `&&` and `and` collapse to one equivalence class before classification
 *  (`{a && b and c}` is therefore the same operator run as `{a and b and c}`). */
export function normalizeGlyph(op: SchemeValue): SchemeValue {
  if (op instanceof SchemeSymbol) {
    const name = typeof op.__name__ === "string" ? op.__name__ : null;
    if (name !== null && name in GLYPH_MAP) {
      return new SchemeSymbol(GLYPH_MAP[name]);
    }
  }
  return op;
}
