// slice.ts — the reverse-chain slicer (Galois `uneval`, naive baseline).
//
// Given a value's provenance (the set of provenance-point ids that flowed into it), produce a
// runnable Scheme program containing ONLY the top-level forms that value depends on — a sound,
// re-runnable reverse chain. This is the lower adjoint of evaluation (Perera–Cheney): arrival's
// PURITY invariant is the theorem that makes the slice sound (nothing outside the dependence
// cone could have influenced the value).
//
// TWO closures compose, and BOTH are needed for a slice that is sound AND runnable:
//   1. DYNAMIC point-cone — backward over the provenance relation from the seed: which evidence
//      reads / derivations actually fed the value (this is what PRUNES untaken branches and
//      unused forms). Control dependence rides along for free: an `(if pred …)` invocation's
//      children include the predicate, and `computeProvenance` already unions `pred.provenance`
//      in — so a gating predicate's forms are in the cone (trace.ts:114-124).
//   2. STATIC define-closure — the dynamic cone names forms that contain a provenance POINT, but
//      a kept form may reference a pure-literal `(define k 5)` that has NO point (a literal has
//      empty provenance, so it never enters the cone). Dropping it would leave the kept form with
//      an unbound symbol. So: transitively keep any top-level `(define name …)` whose `name` is
//      referenced by a kept form. Coarse (a symbol match, not lexical-scope-exact) ⇒ an
//      OVER-approximation: keeps too much, never too little — sound for runnability.
//
// Granularity is TOP-LEVEL FORM (a superset of the Perera–Cheney least slice): honestly
// "sound + runnable", not "provably minimal". Intra-form minimal slicing is the deferred
// heuristic re-roll step.

import type { EvalTrace, Invocation } from "./trace.js";
import { scopeId } from "./scope-id.js";

// Pair / SchemeSymbol are duck-typed (the concrete classes aren't in arrival-scheme's public
// surface) — the same approach as extract-defines.ts / trace-view.tsx.
type DuckPair = { car: unknown; cdr: unknown; toString(quote?: boolean): string };
type DuckSymbol = { __name__: string | symbol };

const isPair = (v: unknown): v is DuckPair =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;
const isSymbol = (v: unknown): v is DuckSymbol =>
  v !== null && typeof v === "object" && "__name__" in v;
const symName = (s: DuckSymbol): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

const isString = (v: unknown): v is { __string__: string } =>
  v !== null && typeof v === "object" && "__string__" in v;
const isNilLike = (v: unknown): boolean =>
  v !== null && typeof v === "object" && (v as { constructor?: { name?: string } }).constructor?.name === "Nil";

/** Re-serialize a homoiconic form to re-PARSEABLE Scheme. The shared value serializer is
 *  display-only — it drops string quotes (`SchemeString.toString` ignores its `quote` arg), so a
 *  rendered slice wouldn't round-trip. This writer quotes strings (the one atom that doesn't
 *  round-trip via `toString`); every other atom (symbol, number, boolean, char, keyword) already
 *  renders re-parseably, and source `__location__` offsets proved unreliable for span-slicing. */
function writeForm(node: unknown): string {
  if (isPair(node)) {
    const parts: string[] = [];
    let cur: unknown = node;
    while (isPair(cur)) {
      parts.push(writeForm(cur.car));
      cur = cur.cdr;
    }
    if (!isNilLike(cur)) parts.push(".", writeForm(cur)); // improper/dotted tail
    return `(${parts.join(" ")})`;
  }
  if (isString(node)) return JSON.stringify(node.__string__); // the one non-round-tripping atom
  return String(node); // symbol / number / boolean / char / keyword all round-trip via toString
}

/** A reverse-chain slice: the runnable derivation + the structured cone for downstream
 *  consumers (the attestation per-leaf→read join, a UI source highlight). */
export interface Slice {
  /** The sliced top-level forms, in original eval order, rendered as runnable Scheme. */
  program: string;
  /** The dynamic point-cone — the provenance-point invocation ids the value depends on. THESE
   *  are the evidence reads: the per-leaf→read join key the attestation needs. */
  points: number[];
  /** `scopeId` of each kept form (a stable source-location key — for UI source highlighting). */
  scopeIds: string[];
  /** The kept top-level form nodes (the homoiconic Pairs), in order. */
  formNodes: unknown[];
}

/** Build the reverse-chain slice for a value, seeded by its provenance set. Pure + deterministic
 *  — no LLM, just graph reachability over the trace. */
export function buildSlice(trace: EvalTrace, seed: Iterable<number>): Slice {
  // id → Invocation (the standard rebuild; every binding of every recorded node).
  const invById = new Map<number, Invocation>();
  for (const rec of trace.records.values()) for (const inv of rec.bindings) invById.set(inv.id, inv);

  // A field-point id (minted by a `(:field x)` projection) resolves to the real producing
  // invocation by walking `fieldPointMeta` until there's no entry (trace.ts:333-339).
  const resolveOrigin = (id: number): number => {
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const meta = trace.fieldPointMeta.get(cur);
      if (!meta) break;
      cur = meta.origin;
    }
    return cur;
  };

  // (1) DYNAMIC point-cone: a provenance point's own `provenance` is `{self.id}`, so its UPSTREAM
  // producers come from its children's provenance (the inputs to the call) — the same upstream
  // rule the statechart / regions encode. Walk it transitively.
  const cone = new Set<number>();
  const work: number[] = [];
  for (const s of seed) work.push(resolveOrigin(s));
  while (work.length > 0) {
    const p = work.pop()!;
    if (cone.has(p)) continue;
    cone.add(p);
    const inv = invById.get(p);
    if (!inv) continue;
    for (const child of inv.children) for (const u of child.provenance) work.push(resolveOrigin(u));
    if (inv.symbolContributions) for (const set of inv.symbolContributions) for (const u of set) work.push(resolveOrigin(u));
  }

  // Top-level form of an invocation = the root of its dynamic call chain (each top-level form is
  // exec'd under one tap with `parent=null` at its form node — project.ts / sift discovery.ts).
  const rootOf = (inv: Invocation): Invocation => {
    let c = inv;
    while (c.parent) c = c.parent;
    return c;
  };

  // Enumerate EVERY top-level form (node → its enter-order id, the min across re-entries), and
  // index the top-level defines by name — the material for the static closure + ordering.
  const formId = new Map<unknown, number>();
  for (const inv of invById.values()) {
    const root = rootOf(inv);
    const prev = formId.get(root.node);
    if (prev === undefined || root.id < prev) formId.set(root.node, root.id);
  }
  const defineByName = new Map<string, unknown>();
  for (const node of formId.keys()) {
    const name = defineName(node);
    if (name !== null) defineByName.set(name, node);
  }

  // Kept forms — seeded by the cone.
  const kept = new Set<unknown>();
  for (const p of cone) {
    const inv = invById.get(p);
    if (inv) kept.add(rootOf(inv).node);
  }

  // (2) STATIC define-closure to a fixpoint: pull in any top-level define a kept form references.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of [...kept]) {
      for (const sym of referencedSymbols(node)) {
        const def = defineByName.get(sym);
        if (def !== undefined && !kept.has(def)) {
          kept.add(def);
          changed = true;
        }
      }
    }
  }

  // Order by enter id (lower = earlier in source) and re-serialize each kept form.
  const ordered = [...kept].sort((a, b) => (formId.get(a) ?? 0) - (formId.get(b) ?? 0));
  return {
    program: ordered.map((n) => writeForm(n)).join("\n"),
    points: [...cone],
    scopeIds: ordered.map((n) => scopeId(n)),
    formNodes: ordered,
  };
}

/** The defined name of `(define name …)` / `(define (name …) …)`, else null. */
function defineName(form: unknown): string | null {
  if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== "define") return null;
  if (!isPair(form.cdr)) return null;
  const head = form.cdr.car;
  if (isPair(head) && isSymbol(head.car)) return symName(head.car);
  if (isSymbol(head)) return symName(head);
  return null;
}

/** Every symbol name referenced anywhere in a form's Pair tree (cycle-guarded). Coarse by design
 *  — the static closure wants an over-approximation, not lexical-scope precision. */
function referencedSymbols(form: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (isSymbol(n)) {
      out.add(symName(n));
      return;
    }
    if (isPair(n)) {
      walk(n.car);
      walk(n.cdr);
    }
  };
  walk(form);
  return out;
}
