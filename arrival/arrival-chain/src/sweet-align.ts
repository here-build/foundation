/**
 * Sweet ↔ classic SPAN ALIGNMENT — the coordinate half of the bifunctor.
 *
 * sweet-render stamps classic spans on parsed nodes (parseSexprs); sweet-read
 * stamps sweet spans on the nodes it reads (for the parameter hints). Both
 * trees are STRUCTURALLY EQUAL by the round-trip law (read(render(x)) ≡ x), so
 * a lockstep walk pairs every node that carries a span on both sides — and
 * that pairing IS the sweet↔classic position mapping, recovered entirely from
 * metadata the two transforms already produce. Nothing here re-derives layout.
 *
 * The classic text aligned against is the CANONICAL REPRINT of the sweet
 * buffer (readSweet → printScheme), not the studio's stored classic — the two
 * may differ in formatting bytes, but a consumer that round-trips spans
 * through THIS classic (e.g. an IDE backend that takes the text per call)
 * never sees the difference.
 *
 * Coverage is honest, not total: sweet spans exist only where sweet-read
 * could stamp them (single-physical-line tokens), and synthetic atoms (the
 * `lambda` behind `=>`, the `equal?` behind `==`, accessors behind `[0]`)
 * have no sweet text of their own. Unpaired regions degrade by containment —
 * a query inside one lifts to the nearest enclosing pair.
 */

import { readSweet } from "./sweet-read.js";
import { parseSexprs, printScheme, type Node } from "@here.build/arrival-scheme";

/** One paired node: the same datum's span in both projections. `exact` means
 *  both sides are the SAME atom text (so positions translate offset-precise);
 *  inexact pairs (lists, glyph-swapped atoms) translate by containment only. */
export interface SweetSpanPair {
  sweetStart: number;
  sweetEnd: number;
  classicStart: number;
  classicEnd: number;
  exact: boolean;
}

export interface SweetAlignment {
  /** Canonical classic reprint of the sweet buffer — the text to hand to any
   *  classic-coordinate consumer (language service, runtime, …). */
  classic: string;
  pairs: SweetSpanPair[];
  /** Sweet position → classic position, through EXACT atom pairs only —
   *  token precision or nothing (inclusive of the atom's end, where a typing
   *  cursor sits). A position on sugar (glyphs, elided parens, whitespace)
   *  returns null; position consumers (hover/completion/goto) should degrade
   *  rather than answer about the wrong token. */
  toClassic(sweetPos: number): number | null;
  /** Classic span → sweet span. Offset-exact within an exact atom; otherwise
   *  the innermost containing pair's whole sweet span; null when uncovered. */
  toSweet(classicStart: number, classicLength: number): { start: number; length: number } | null;
}

const isAtomNode = (n: Node): n is { atom: string; str?: boolean; span?: readonly [number, number] } => "atom" in n;

/** Lockstep walk: pair spans wherever BOTH trees carry one. The trees are
 *  equal by construction; a shape mismatch (defensive) just stops descending
 *  that branch rather than failing the whole alignment. */
function collectPairs(sweet: Node, classic: Node, out: SweetSpanPair[]): void {
  const sAtom = isAtomNode(sweet);
  const cAtom = isAtomNode(classic);
  if (sAtom !== cAtom) return;
  if (sweet.span && classic.span) {
    const exact = sAtom && cAtom && sweet.atom === classic.atom && !!sweet.str === !!classic.str;
    out.push({
      sweetStart: sweet.span[0],
      sweetEnd: sweet.span[1],
      classicStart: classic.span[0],
      classicEnd: classic.span[1],
      exact,
    });
  }
  if (sAtom || cAtom) return;
  const a = sweet.list;
  const b = (classic as { list: Node[] }).list;
  if (a.length !== b.length) return;
  for (let i = 0; i < a.length; i++) collectPairs(a[i], b[i], out);
}

/** Innermost pair containing the query — smallest span on the queried side. */
function innermost(
  pairs: SweetSpanPair[],
  contains: (p: SweetSpanPair) => boolean,
  sizeOf: (p: SweetSpanPair) => number,
): SweetSpanPair | null {
  let best: SweetSpanPair | null = null;
  for (const p of pairs) {
    if (!contains(p)) continue;
    if (best === null || sizeOf(p) < sizeOf(best)) best = p;
  }
  return best;
}

/**
 * Align a sweet buffer against its own canonical classic reprint. Returns null
 * when the sweet text doesn't parse (mid-edit) — the consumer keeps its last
 * good answers, exactly like the save-back path keeps its last good classic.
 */
export function alignSweetClassic(sweetText: string): SweetAlignment | null {
  let sweetForms: Node[];
  try {
    sweetForms = readSweet(sweetText);
  } catch {
    return null;
  }
  const classic = sweetForms.map((f) => printScheme(f)).join("\n\n");
  const classicForms = parseSexprs(classic);
  if (classicForms.length !== sweetForms.length) return null;

  const pairs: SweetSpanPair[] = [];
  for (let i = 0; i < sweetForms.length; i++) collectPairs(sweetForms[i], classicForms[i], pairs);

  const toClassic = (sweetPos: number): number | null => {
    // Inclusive end: a typing cursor at an atom's end still belongs to it.
    const p = innermost(
      pairs,
      (q) => q.exact && q.sweetStart <= sweetPos && sweetPos <= q.sweetEnd,
      (q) => q.sweetEnd - q.sweetStart,
    );
    if (p === null) return null;
    return p.classicStart + Math.min(sweetPos - p.sweetStart, p.classicEnd - p.classicStart);
  };

  const toSweet = (classicStart: number, classicLength: number): { start: number; length: number } | null => {
    const end = classicStart + classicLength;
    const p = innermost(
      pairs,
      (q) => q.classicStart <= classicStart && end <= q.classicEnd,
      (q) => q.classicEnd - q.classicStart,
    );
    if (p === null) return null;
    if (p.exact) return { start: p.sweetStart + (classicStart - p.classicStart), length: classicLength };
    return { start: p.sweetStart, length: p.sweetEnd - p.sweetStart };
  };

  return { classic, pairs, toClassic, toSweet };
}
