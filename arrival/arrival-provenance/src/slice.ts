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

import invariant from "tiny-invariant";

import { scopeId } from "./scope-id.js";
import type { EvalTrace, Invocation } from "./trace.js";

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
  // `seen` guards against a cyclic/shared structure (a reader-built `#0=(a . #0#)`): without it the
  // pair/vector recursion spins to a RangeError. A cyclic datum has no finite read syntax — throw a
  // clear error (errors-as-doors) rather than hang.
  return writeDatum(node, new Set<unknown>());
}

/** Re-serialize an inexact/number datum to a RE-PARSEABLE numeral. JS `String()` (via the boxed
 *  `toString`) has two failure modes the reader rejects: an integer-valued inexact in exponential
 *  form gets a spurious trailing `.0` (`1.5e+300.0` — re-parses as a SYMBOL), and negative zero
 *  loses its sign. Fix both at the slice boundary (the shared number repr is display-only). */
function writeNumber(node: unknown): string {
  const r = (node as { real?: unknown }).real;
  if (typeof r === "number" && Object.is(r, -0)) return "-0.0";
  // `1.5e+300.0` → `1.5e+300`: strip a `.0` that follows an exponent (an exponent already marks it
  // inexact, so the `.0` the boxed toString appends for integer-valued inexacts is both redundant
  // and unreadable).
  return String(node).replace(/(e[+-]?\d+)\.0$/i, "$1");
}

function writeDatum(node: unknown, seen: Set<unknown>): string {
  // Raw JS primitives — defensive; parsed forms are boxed, but a stray unbox shouldn't corrupt.
  if (typeof node === "string") return JSON.stringify(node);
  if (typeof node === "number" || typeof node === "bigint") {
    return typeof node === "number" && Object.is(node, -0) ? "-0.0" : String(node);
  }
  if (typeof node === "boolean") return node ? "#t" : "#f";
  invariant(node !== null && node !== undefined, () => `writeForm: cannot serialize ${String(node)} to Scheme source`);
  const kind = kindOf(node);
  // A cyclic datum has no finite read syntax (errors-as-doors: construct a new value, don't cycle).
  const CYCLE = "writeForm: cyclic datum has no read syntax — cannot serialize to re-runnable Scheme";
  switch (kind) {
    case "pair": {
      invariant(!seen.has(node), CYCLE);
      seen.add(node);
      const parts: string[] = [];
      let cur: unknown = node;
      while (isPair(cur)) {
        parts.push(writeDatum(cur.car, seen));
        cur = cur.cdr;
        invariant(!(isPair(cur) && seen.has(cur)), CYCLE);
      }
      if (kindOf(cur) !== "nil") parts.push(".", writeDatum(cur, seen)); // improper/dotted tail
      return `(${parts.join(" ")})`;
    }
    case "string":
      return JSON.stringify((node as { __string__: string }).__string__);
    case "vector": {
      invariant(!seen.has(node), CYCLE);
      seen.add(node);
      return `#(${(node as { __vector__: unknown[] }).__vector__.map((el) => writeDatum(el, seen)).join(" ")})`;
    }
    case "bytevector":
      return `#u8(${[...(node as { __bytevector__: Uint8Array }).__bytevector__].join(" ")})`;
    case "number":
      return writeNumber(node);
    case "symbol":
    case "character":
    case "bool":
    case "nil":
      return String(node); // each round-trips: name / #\c / #t#f / ()
    default:
      // A procedure / host object has no read syntax — a slice must be re-runnable source, so fail
      // loud rather than emit `[object Object]` that re-parses to a different datum.
      invariant(false, () => `writeForm: non-serializable datum kind "${kind ?? typeof node}" — no read syntax`);
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

/** Resolve provenance ids to their EVIDENCE-READ ids — the canonical join space. A `(:field x)`
 *  projection mints a lazy field-point id `{origin, key}` (a "destruction provenance node" recorded
 *  as metadata, not materialized as an invocation — which is why minting real nodes is unnecessary
 *  and would re-introduce the O(history) blowup the lazy form avoids); this walks each id through
 *  `fieldPointMeta` to the real read invocation. A plain read id passes through unchanged.
 *  `buildSlice.points` is already in this space, so resolved leaf ids join to it by construction. */
export function resolveReadIds(trace: EvalTrace, ids: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const meta = trace.fieldPointMeta.get(cur);
      if (!meta) break;
      cur = meta.origin;
    }
    out.add(cur);
  }
  return [...out];
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

  // Index top-level defines by name — ALL of them, not just the last. A name can be (re)defined
  // multiple times: an accumulator `(define x (f x))`, or sift's REPL replay (history + expr as
  // separate top-level forms re-binding a name). Keeping only the last form drops the earlier
  // binding the later one depends on → unbound on re-run. Keep every form for a referenced name; in
  // source order they reproduce the rebinding sequence.
  const defineForms = new Map<string, unknown[]>();
  for (const node of formId.keys()) {
    const name = defineNameOf(node);
    if (name === null) continue;
    const arr = defineForms.get(name);
    if (arr) arr.push(node);
    else defineForms.set(name, [node]);
  }

  // STATIC BACKWARD CLOSURE: seed from the anchor symbols, then keep any top-level define a kept
  // form references, to a fixpoint. This pulls in the value's binding form(s) AND its whole consumer
  // chain (the structural fix for the cone's under-inclusion).
  const kept = new Set<unknown>();
  const keepName = (sym: string): boolean => {
    let added = false;
    for (const def of defineForms.get(sym) ?? []) {
      if (!kept.has(def)) {
        kept.add(def);
        added = true;
      }
    }
    return added;
  };
  for (const sym of anchorSymbols) keepName(sym);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of kept) {
      for (const sym of referencedSymbols(node)) {
        if (keepName(sym)) changed = true;
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
  invariant(!program.includes("[object "), "buildSlice: emitted a non-serialized object — writeForm coverage gap");
  return { program, points, scopeIds: ordered.map((n) => scopeId(n)), formNodes: ordered };
}
