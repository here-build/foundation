// slice.ts — the reverse-chain slicer (Galois `uneval`, naive baseline).
//
// Given the OUTPUT EXPRESSION of a run, produce the runnable top-level forms its value depends on
// — a sound, re-runnable reverse chain (Perera–Cheney `uneval`; arrival's PURITY invariant is the
// soundness theorem). Re-running the slice reproduces the value.
//
// SELECTION IS BY STATIC BACKWARD REFERENCE-CLOSURE, not the provenance cone. An adversarial swarm
// proved the cone approach unsound: the cone walks UPSTREAM from the value to its evidence reads,
// so it structurally cannot name the value's own binding form or any pure-combinator consumer
// between the reads and the output (string-append/if/list/quasiquote bodies are not provenance
// points, and the forward "keep defines referenced by kept forms" closure never reaches a
// CONSUMER). The fix inverts it: seed from the symbols the OUTPUT expression references, then
// transitively keep every top-level (define name …) reachable through references. That keeps the
// whole consumer chain by construction and is trivially runnable (a closed subset of forms that
// already ran). Granularity is top-level form: sound + runnable, a superset of the least slice
// (intra-form minimal slicing is the deferred increment).
//
// The provenance points are still surfaced (`points`) — derived from which reads land in the kept
// forms — as the attestation per-leaf→read join key and a UI source-highlight seed.

import type { EvalTrace, Invocation } from "./trace.js";
import { scopeId } from "./scope-id.js";

// Datum kinds are discriminated on the authoritative `kind` tag every AValue carries — NOT on
// structural duck-typing. (A SchemeCharacter carries `__name__` for its named form like #\space,
// so `"__name__" in v` misclassifies chars as symbols — a real crash the swarm found.)
const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;

type DuckPair = { car: unknown; cdr: unknown };
type DuckSymbol = { __name__: string | symbol };

const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";
const symName = (s: DuckSymbol): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** Re-serialize a homoiconic form to RE-PARSEABLE Scheme — total over the datum algebra. The
 *  shared value serializer is display-only (drops string quotes; renders boxed vectors as
 *  `[object Object]`), so a rendered slice wouldn't round-trip. Strings are JSON.stringify'd;
 *  vectors/bytevectors get their reader syntax; symbol/char/number/bool/nil round-trip via their
 *  own `toString`; anything NON-serializable (a procedure, a host object) THROWS — a slice must
 *  never silently emit `[object Object]` and re-parse to a different datum. */
export function writeForm(node: unknown): string {
  // Raw JS primitives — defensive; parsed forms are boxed, but a stray unbox shouldn't corrupt.
  if (typeof node === "string") return JSON.stringify(node);
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (typeof node === "boolean") return node ? "#t" : "#f";
  if (node === null || node === undefined) {
    throw new Error(`writeForm: cannot serialize ${String(node)} to Scheme source`);
  }
  const kind = kindOf(node);
  switch (kind) {
    case "pair": {
      const parts: string[] = [];
      let cur: unknown = node;
      while (isPair(cur)) {
        parts.push(writeForm(cur.car));
        cur = cur.cdr;
      }
      if (kindOf(cur) !== "nil") parts.push(".", writeForm(cur)); // improper/dotted tail
      return `(${parts.join(" ")})`;
    }
    case "string":
      return JSON.stringify((node as { __string__: string }).__string__);
    case "vector":
      return `#(${(node as { __vector__: unknown[] }).__vector__.map(writeForm).join(" ")})`;
    case "bytevector":
      return `#u8(${Array.from((node as { __bytevector__: Uint8Array }).__bytevector__).join(" ")})`;
    case "symbol":
    case "character":
    case "number":
    case "bool":
    case "nil":
      return String(node); // each round-trips: name / #\c / numeral / #t#f / ()
    default:
      throw new Error(
        `writeForm: non-serializable datum kind "${kind ?? typeof node}" — a reverse-chain slice ` +
          `must be re-runnable source, but this datum has no read syntax`,
      );
  }
}

/** A reverse-chain slice: the runnable derivation + the structured data downstream consumers need
 *  (the attestation per-leaf→read join, a UI source highlight). */
export interface Slice {
  /** The reachable top-level DEFINE forms, in source order, as runnable Scheme. The caller appends
   *  its terminator (the output expression, or a `(define result …)` + selector). */
  program: string;
  /** The provenance-point ids whose producing form is in the slice — the evidence READS the
   *  derivation makes. The per-leaf→read join key. */
  points: number[];
  /** `scopeId` of each kept form (stable source-location keys, for UI highlighting). */
  scopeIds: string[];
  /** The kept top-level form nodes, in order. */
  formNodes: unknown[];
}

/** The defined name of `(define name …)` / `(define (name …) …)`, else null. */
export function defineNameOf(form: unknown): string | null {
  if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== "define") return null;
  if (!isPair(form.cdr)) return null;
  const head = form.cdr.car;
  if (isPair(head) && isSymbol(head.car)) return symName(head.car);
  if (isSymbol(head)) return symName(head);
  return null;
}

/** Every symbol name referenced anywhere in a form's tree (cycle-guarded, kind-discriminated).
 *  Coarse by design — the closure wants an over-approximation, not lexical-scope precision. */
export function referencedSymbols(form: unknown): Set<string> {
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
      return;
    }
    if (kindOf(n) === "vector") for (const el of (n as { __vector__: unknown[] }).__vector__) walk(el);
    // strings / chars / numbers / nil reference nothing.
  };
  walk(form);
  return out;
}

/** The last-entered top-level form in the trace (the run's output expression) — the natural anchor
 *  for a self-contained reverse chain. */
export function lastTopLevelForm(trace: EvalTrace): unknown {
  let best: unknown;
  let bestId = -1;
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      if (inv.parent === null && inv.id > bestId) {
        bestId = inv.id;
        best = inv.node;
      }
    }
  }
  return best;
}

/** Build the reverse-chain slice: the reachable top-level defines that the run's OUTPUT FORM
 *  depends on, by STATIC BACKWARD REFERENCE-CLOSURE from the symbols it references. Pure +
 *  deterministic. `program` is the DEFINES ONLY (in source order); the caller appends its
 *  terminator (the output expression, or `(define result …)` + selector). `points` counts the
 *  evidence reads in the kept defines AND in the output form itself (its inline reads — the common
 *  forensic case `(list (:Field (car (read))))` has no defines at all). */
export function buildSlice(trace: EvalTrace, outputNode: unknown): Slice {
  const anchorSymbols = outputNode === undefined ? new Set<string>() : referencedSymbols(outputNode);
  // id → Invocation, and every top-level form node → its enter-order id (min across re-entries).
  const invById = new Map<number, Invocation>();
  const formId = new Map<unknown, number>();
  const rootOf = (inv: Invocation): Invocation => {
    let c = inv;
    while (c.parent) c = c.parent;
    return c;
  };
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      invById.set(inv.id, inv);
      const root = rootOf(inv);
      const prev = formId.get(root.node);
      if (prev === undefined || root.id < prev) formId.set(root.node, root.id);
    }
  }

  // Index top-level defines by name.
  const defineByName = new Map<string, unknown>();
  for (const node of formId.keys()) {
    const name = defineNameOf(node);
    if (name !== null) defineByName.set(name, node);
  }

  // STATIC BACKWARD CLOSURE: seed from the anchor symbols, then keep any top-level define a kept
  // form references, to a fixpoint. This pulls in the value's binding form AND its whole consumer
  // chain (the structural fix for the cone's under-inclusion).
  const kept = new Set<unknown>();
  for (const sym of anchorSymbols) {
    const def = defineByName.get(sym);
    if (def !== undefined) kept.add(def);
  }
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

  // points = the provenance-point reads whose producing form is in the slice OR in the output form
  // (the evidence the derivation reads — the attestation join key). The output form's inline reads
  // count even though it isn't a kept define (the caller emits it as the terminator).
  const points: number[] = [];
  for (const inv of invById.values()) {
    if (!inv.isProvenancePoint) continue;
    const root = rootOf(inv).node;
    if (kept.has(root) || root === outputNode) points.push(inv.id);
  }

  // Order by enter id (source order) and re-serialize.
  const ordered = [...kept].sort((a, b) => (formId.get(a) ?? 0) - (formId.get(b) ?? 0));
  const program = ordered.map((n) => writeForm(n)).join("\n");
  // Structural backstop: writeForm throws on a non-serializable datum, but assert no object slipped
  // through any raw path — a slice must never carry `[object Object]`.
  if (program.includes("[object ")) {
    throw new Error("buildSlice: emitted a non-serialized object — writeForm coverage gap");
  }
  return { program, points, scopeIds: ordered.map((n) => scopeId(n)), formNodes: ordered };
}
