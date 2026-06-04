/**
 * trace → REGION TREE — the structural model behind the blueprint render: infer
 * calls as leaves, fan-out (map/filter/fold) as CONTAINERS whose N iterations are
 * kept DISTINCT (so the render can stack them on a virtual Z-axis = tabs, one tree
 * shown at a time rather than N laid out flat). Built from the RAW invocation tree
 * (not the scope-collapsing forest), so iterations survive and the nesting is real.
 *
 * The rules, walking each invocation:
 *   - provenance point (an `(infer …)` / `.prompt` call) → a LEAF.
 *   - fan-out head (`map`/`filter`/`fold`/…) → a CONTAINER; its iterations are the
 *     child applications (the children that carry a body — the eval'd-once args,
 *     the lambda + the collection, have none).
 *   - anything else (let, if, list, a plain function call) → PLUMBING: flattened
 *     through to the meaningful regions inside it.
 *
 * Plus the dataflow WIRES: the provenance edges between leaves (`⋃ child.provenance`
 * over a point's children ∩ the point set — the same rule the statechart/chain use).
 *
 * TCO containers: a self-recursive function (`loop ⊃ … ⊃ loop`, detected the same
 * way `traceToForest` does — a non-structural application that recurs on its own
 * ancestor chain) is peeled into one `fanout` container whose N iterations are the
 * successive body entries. The trampoline collapses the host stack, but the trace's
 * `currentInvocation` parent-link still chains, so the recursion spine is walkable.
 * Each iteration = that call's children, CUT at the next recursive call (so the next
 * iteration's body doesn't leak in); the recursive call's argument eval (e.g. the
 * `reflect` that seeds the next iteration) rides in as an arg, so nothing is lost —
 * it surfaces at the head of the iteration whose input it produced.
 *
 * Sequential loop iterations reuse the `fanout` container (Z-tab render, one shown
 * at a time) rather than a distinct kind — V's call. `tailPosition` (the evaluator's
 * R7RS §3.5 ground truth, on `Invocation`) is available if we later want to label
 * proper-TCO vs stack-growing recursion; detection here is structural so it covers
 * both. PERF: a very long loop builds an O(N)-deep `currentInvocation` chain; the
 * spine walk is O(N) total (early-return DFS), bounded by that existing depth.
 */
import { lipsToJs } from "@here.build/arrival-scheme";
import { snapshotTrace, type PlainInv } from "./trace-snapshot.js";
import { schemeToSweet } from "./sweet-render.js";
import { scopeId, staticLoopBodyScopes, staticRecursiveHeads, STRUCTURAL_FORMS } from "./trace-to-forest.js";
import type { EvalTrace } from "./trace.js";

/** A producer crossing a region's boundary — the region-model's first-class PORT
 *  (docs/working-proposals/provenance-region-model-plan-2026-06-02.md, Stage 2).
 *  Keyed by the producer's STRUCTURAL scope-id, NOT per-value: a `map`/loop body that
 *  runs N times emits ONE port per structural producer (one dataflow), matching the
 *  `leaf.scope` contract. This is what makes each container a hermetic mini-chart with
 *  explicitly known granular inputs and outputs. */
export interface RegionPort {
  /** The producer's structural scope-id (`head@line:col`) crossing the boundary. */
  producer: string;
  /** The consumer's named input slot the value flowed into, when recoverable (a
   *  `.prompt` kwarg) — carried straight off the crossing edge's `field`. */
  field?: string;
}

export type Region =
  | {
      kind: "leaf";
      id: number;
      label: string;
      /** Stable STRUCTURAL identity (`head@line:col`) — the same string for every
       *  iteration of one `(infer …)` call. The render keys a container's boundary
       *  ports by this, so a `map`/loop body that runs N times emits ONE exit port
       *  per structural producer (one dataflow), not N (one per value). */
      scope: string;
      nodeKind: "direct" | "prompt";
      /** Node metadata bound via `resultWithProvenance` — a `.prompt` leaf carries
       *  `{ kind:"prompt", path, model, inputs }`; a bare `(infer …)` has none. The
       *  render draws the node's card from this. */
      meta?: unknown;
      /** The resolved inference result (`undefined` while still running). */
      value?: unknown;
      /** running | resolved | rejected — pending vs result vs error in the card. */
      state: "running" | "resolved" | "rejected";
    }
  | {
      /** A `<>` DECISION MARKER — the point a live branch (`if`/`cond`/…) decided
       *  one way HERE. It does NOT box or fork the flow: the divergence between
       *  arms is already absorbed by the enclosing autonomous region's iteration
       *  picker (map/filter/TCO Z-tabs), so the marker only annotates "a decision
       *  was made here". The taken arm's content follows it as ordinary siblings. */
      kind: "decision";
      id: number;
      /** The branch head — `if` | `cond` | `case` | `when` | `unless`. */
      label: string;
      /** Stable source-location identity (`head@line:col`) of the branch site. */
      scope: string;
      /** A HUMAN-READABLE rendering of the branch's test, recovered from the AST —
       *  `score > 0.6`, `stage is "analyze"`, `fails is empty`. Known predicate
       *  shapes get a tidy phrase; anything unrecognized falls back to the verbatim
       *  s-expression (so it's never worse than showing the code). The decision node
       *  TALKS instead of showing a bare `<>`. AST-only for now: value-substitution
       *  (`score (0.73) > 0.6`) needs the test's runtime value, which the snapshot
       *  doesn't carry for non-points — that's the next layer. `cond`/`case` are
       *  multi-clause and stay unlabelled here (also next layer). */
      condition?: string;
    }
  | {
      kind: "fanout";
      id: number;
      /** The fused transform breadcrumb, outermost→innermost. ONE entry = a plain
       *  `map`/`filter`/TCO `loop`; SEVERAL = a fused chain (`map ▸ filter ▸ map`)
       *  the cleanup pass collapsed into one frame. Each carries its own invocation
       *  id so the render can later cmd-click-navigate to that stage's call site.
       *  For ELK the whole fanout — chain included — is ONE node, never its stages. */
      stages: { label: string; id: number }[];
      /** Distinct iterations, MEANINGFUL ones only (degenerate — no inference
       *  inside — pruned by the cleanup pass). The render stacks them on Z-tabs. */
      iterations: Region[][];
      /** Raw incoming invocation count BEFORE pruning. `iterations.length` is how
       *  many carried inference — the banner reads "10 incoming, 5 mattered". */
      incoming: number;
      /** True when this container is a TCO SELF-RECURSION loop (peeled from a body
       *  that re-enters itself in tail position), as opposed to a `map`/`filter`
       *  fan-out over a collection. The render draws a loop-back arc on the frame —
       *  a wire leaving the contour and pointing back into it — so recursion reads
       *  as recursion, not as an N-way fan. */
      loop?: boolean;
      /** The container's BOUNDARY ports (Stage 2 — regions ARE boxes). `inputs` =
       *  external producers whose values flow into its internals (entrance);
       *  `outputs` = internal producers whose values flow outside (exit). Derived by
       *  pure edge-vs-membership over the region tree — an edge `P→C` is an input of
       *  every container holding `C` but not `P`, an output of every container holding
       *  `P` but not `C` — keyed by producer scope so each structural producer is ONE
       *  port regardless of iteration count. This is what lets a collapsed region show
       *  just its ports instead of its exploded internals. */
      inputs: RegionPort[];
      outputs: RegionPort[];
    }
  | {
      /** The program's final STATEMENT OUTPUT — the value the last top-level
       *  expression returned. A single terminal node the whole graph flows into,
       *  wired from its immediate producers (the last infer/region its value came
       *  from). Rendered as a small terminal card, not a producer leaf. */
      kind: "output";
      id: number;
      value: unknown;
      state: PlainInv["state"];
    };

export interface RegionGraph {
  /** Top-level meaningful regions, plumbing flattened away. */
  roots: Region[];
  /** Dataflow wires between leaf invocation ids (producer → consumer). `field` is
   *  the consumer's INPUT slot the producer's value flowed into — the named kwarg of
   *  a `.prompt` consumer (`"analysis"` for `… :analysis a`), DERIVED by matching the
   *  producer's value against the consumer's `inputs` dict (not stored in the model:
   *  it's recoverable from data already captured). Absent when the consumer isn't a
   *  `.prompt`, or when the value was PROJECTED/transformed before it reached the
   *  slot (then `inputs[k] !== producer.value` and the match honestly declines —
   *  attributing a projected input needs provenance-on-value, the v1 follow-up). */
  edges: { from: number; to: number; field?: string; kind: "data" | "control" }[];
  warnings: string[];
}

/** Heads that fan out: each applies a function across a collection. */
const FANOUT: ReadonlySet<string> = new Set(["map", "filter", "fold", "fold-left", "fold-right", "for-each", "mapcat", "flat-map", "flatmap"]);

/** DNF control forms — the branching shapes. A branch is INVISIBLE plumbing by
 *  default (the taken arm flattens through), and becomes a rendered container
 *  ONLY when the SAME source-location branch was exercised ≥2 distinct ways
 *  across the whole trace (see `liveBranchScopes`). An always-one-way branch is
 *  seamless — in THIS run it never decided anything, so it isn't a decision. */
const BRANCH_FORMS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);

const headOf = (inv: PlainInv): string => scopeId(inv.node).split("@")[0] ?? "?";

// ── readable predicate recovery (the decision node TALKS) ────────────────────
// Recover a human phrase from a branch's test Pair. Known shapes → a tidy phrase;
// anything else → the verbatim s-expression (never worse than the code). AST-only:
// the static predicate, not yet the runtime value it tested.
interface PairLike {
  car: unknown;
  cdr: unknown;
}
const asPair = (v: unknown): PairLike | null =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v ? (v as PairLike) : null;
const symOf = (v: unknown): string | undefined => {
  const n = (v as { __name__?: unknown } | null)?.__name__;
  return typeof n === "string" ? n : undefined;
};
const listOf = (v: unknown): unknown[] => {
  const out: unknown[] = [];
  for (let c = asPair(v); c; c = asPair(c.cdr)) out.push(c.car);
  return out;
};
/** Annotate a symbol with its resolved runtime value — `(sym) => "(value)" | ""`.
 *  The empty string means "no value to show" (unresolved free var / a literal). */
type Annotate = (sym: string) => string;
const NO_ANNOTATE: Annotate = () => "";

const atomStr = (v: unknown, ann: Annotate = NO_ANNOTATE): string => {
  const s = symOf(v);
  if (s !== undefined) return `${s}${ann(s)}`;
  if (v === null) return "()";
  if (asPair(v)) return sexpr(v, ann);
  const vo = (v as { valueOf?: () => unknown } | undefined)?.valueOf?.();
  if (typeof vo === "string") return JSON.stringify(vo);
  if (typeof vo === "number" || typeof vo === "bigint" || typeof vo === "boolean") return String(vo);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "…";
};
const sexpr = (v: unknown, ann: Annotate = NO_ANNOTATE): string =>
  asPair(v) ? `(${listOf(v).map((x) => atomStr(x, ann)).join(" ")})` : atomStr(v, ann);

const INFIX: Readonly<Record<string, string>> = { ">": ">", "<": "<", ">=": "≥", "<=": "≤", "=": "=", "equal?": "is", "eq?": "is", "eqv?": "is" };
/** The negated comparison — what the operator becomes on the arm where the test was
 *  FALSE. `a > b` failing IS `a ≤ b`, so the realized condition reads as the negation,
 *  not `a > b → no`. Equality's negation is `≠` / `is not`. */
const NEG_INFIX: Readonly<Record<string, string>> = { ">": "≤", "<": "≥", ">=": "<", "<=": ">", "=": "≠", "equal?": "is not", "eq?": "is not", "eqv?": "is not" };

/** Render a test OPERAND. A compound operand (`(car prop)`, `(proposal-batch-score …)`)
 *  goes through the sweet lens — `prop[0]`, curly subscripts — so the pill reads as the
 *  authored expression would. A bare atom keeps its inline runtime-value annotation. */
const renderOperand = (operand: unknown, ann: Annotate): string => {
  if (asPair(operand)) {
    try {
      return schemeToSweet(sexpr(operand, NO_ANNOTATE)).trim();
    } catch {
      return sexpr(operand, ann);
    }
  }
  return atomStr(operand, ann);
};

/**
 * Render a test as the REALIZED condition for the arm that ran — no `→ yes/no` suffix.
 * `taken` is whether the test was true on this path; when false, each shape renders its
 * own negation (`a > b` → `a ≤ b`, `is empty` → `is not empty`, `not X` flips back to
 * `X`). So the pill states the fact that actually held, not the predicate plus an
 * outcome label. Operand symbols carry inline runtime values via `ann`; compound
 * operands pass through the sweet lens.
 */
function readablePolar(test: unknown, taken: boolean, ann: Annotate = NO_ANNOTATE): string {
  const p = asPair(test);
  if (!p) {
    // Bare-symbol guard (`prop`): its realized truth is presence/absence.
    const s = symOf(test);
    const base = s !== undefined ? s : atomStr(test, ann);
    return taken ? `${base} is present` : `${base} is absent`;
  }
  const parts = listOf(test);
  const head = symOf(parts[0]);
  const opr = (i: number): string => renderOperand(parts[i], ann);
  if (head && INFIX[head] && parts.length === 3) return `${opr(1)} ${(taken ? INFIX : NEG_INFIX)[head]} ${opr(2)}`;
  if (head === "zero?" && parts.length === 2) return `${opr(1)} ${taken ? "=" : "≠"} 0`;
  if (head === "null?" && parts.length === 2) return `${opr(1)} is ${taken ? "" : "not "}empty`;
  if (head === "even?" && parts.length === 2) return `${opr(1)} is ${taken ? "" : "not "}even`;
  if (head === "odd?" && parts.length === 2) return `${opr(1)} is ${taken ? "" : "not "}odd`;
  if (head === "string-prefix?" && parts.length === 3) return `${opr(2)} ${taken ? "starts with" : "does not start with"} ${opr(1)}`;
  if (head === "not" && parts.length === 2) return readablePolar(parts[1], !taken, ann); // ¬¬ flips back
  const body = sexpr(test, ann); // fallback: verbatim s-expression
  return taken ? body : `not ${body}`;
}

// ── operand resolution (where the tested value CAME FROM) ────────────────────
// A decision branches on locals (`fails`, `pair`, `prop`) bound by enclosing lets
// whose value-expressions are unrendered plumbing — so a wire would point at an
// invisible node. Instead we resolve each operand to its binding site and read the
// actual value: `fails (∅)`, `pair (#f)`. This is "where it came from" made legible
// inline, the faithful form of operand-wiring when the producer isn't a drawn node.
const LET_FORMS: ReadonlySet<string> = new Set(["let", "let*", "letrec"]);

/** The value-expression a let-family node binds `sym` to, or undefined. Handles the
 *  named-let shape `(let name ((b v)…) …)` whose bindings sit one slot later. */
const bindingValueExpr = (letNode: unknown, sym: string): { valExpr: unknown } | undefined => {
  const parts = listOf(letNode);
  // named let: slot 1 is the loop name (a symbol), bindings shift to slot 2.
  const bindings = symOf(parts[1]) !== undefined ? parts[2] : parts[1];
  for (const b of listOf(bindings)) {
    const bp = listOf(b); // (name valExpr)
    if (symOf(bp[0]) === sym) return { valExpr: bp[1] };
  }
  return undefined;
};

/** Resolve a free symbol in a decision's test to its runtime value, by walking up to
 *  the enclosing let that bound it and reading that binding's producer invocation. */
const resolveRaw = (
  decision: PlainInv,
  sym: string,
  valueById: (id: number) => unknown,
): { value: unknown; producerId?: number } | undefined => {
  for (let anc = decision.parent; anc; anc = anc.parent) {
    if (!LET_FORMS.has(headOf(anc))) continue;
    const found = bindingValueExpr(anc.node, sym);
    if (found === undefined) continue;
    if (asPair(found.valExpr)) {
      const producer = anc.children.find((c) => c.node === found.valExpr);
      // `producerId` is the invocation that computed the binding — a candidate
      // data-input wire (drawn only when it's a rendered provenance point).
      return producer ? { value: valueById(producer.id), producerId: producer.id } : undefined;
    }
    // A literal-bound symbol (`(x 0.6)`) — the value IS the literal.
    return { value: found.valExpr };
  }
  return undefined;
};

/** Compact runtime-value glyph for inline annotation: `(∅)`, `(#f)`, `(0.73)`, `([3])`. */
const fmtVal = (v: unknown): string => {
  if (v === false) return " (#f)";
  if (v === true) return " (#t)";
  if (v === null || v === undefined) return " (∅)";
  if (Array.isArray(v)) return v.length === 0 ? " (∅)" : ` ([${v.length}])`;
  if (typeof v === "string") return ` (${JSON.stringify(v.length > 16 ? `${v.slice(0, 16)}…` : v)})`;
  if (typeof v === "number" || typeof v === "bigint") return ` (${String(v)})`;
  if (typeof v === "object") return " ({…})";
  return ` (${String(v)})`;
};

/** The test's runtime outcome. First the test child's materialized value (compound
 *  test → a child invocation carries the boolean); else, for a bare-symbol test,
 *  the resolved operand value. Scheme truthiness: only `#f` is false. */
const outcomeOf = (
  inv: PlainInv,
  testNode: unknown,
  valueById: (id: number) => unknown,
): "yes" | "no" | undefined => {
  const child = inv.children.find((c) => c.node === testNode);
  if (child !== undefined && child.value !== undefined) return child.value === false ? "no" : "yes";
  const sym = symOf(testNode);
  if (sym !== undefined) {
    const r = resolveRaw(inv, sym, valueById);
    if (r !== undefined) return r.value === false ? "no" : "yes";
  }
  return undefined;
};

/** The readable condition for a branch invocation, or undefined for the multi-clause
 *  forms (`cond`/`case`). Rendered as the REALIZED fact for the arm that ran (polarised
 *  by the recovered outcome — `a > b` on the true arm, `a ≤ b` on the false one), with
 *  static operands carrying their runtime values inline. */
const conditionOf = (
  inv: PlainInv,
  valueById: (id: number) => unknown,
  wired: ReadonlySet<string>,
): string | undefined => {
  const head = headOf(inv);
  if (head === "if" || head === "when" || head === "unless") {
    const test = listOf(inv.node)[1]; // (if TEST then else) → slot 1
    if (test === undefined) return undefined;
    // A WIRED operand's value arrives on a data wire (from the infer it derived from),
    // so the pill shows just its NAME — the value lives at the wire's source. A STATIC
    // (literal-rooted) operand has no wire, so its value is annotated inline.
    const ann: Annotate = (sym) => {
      if (wired.has(sym)) return "";
      const r = resolveRaw(inv, sym, valueById);
      return r === undefined ? "" : fmtVal(r.value);
    };
    // The realized condition is the test under its taken polarity: an undetermined
    // outcome falls back to the as-written (true) form.
    const outcome = outcomeOf(inv, test, valueById);
    return readablePolar(test, outcome !== "no", ann);
  }
  return undefined;
};

/** The provenance set carried by a raw scheme VALUE — non-empty when it's an AValue
 *  stamped by a producer (a field-pluck off an infer, an infer result). Read
 *  structurally to avoid importing AValue here; a literal/unstamped value yields none. */
const valueProvenance = (v: unknown): Iterable<number> => {
  const p = (v as { provenance?: unknown } | null | undefined)?.provenance;
  return p != null && typeof (p as Iterable<number>)[Symbol.iterator] === "function" ? (p as Iterable<number>) : [];
};

/** Symbols appearing in a test expression (operator heads included — harmless, they
 *  never resolve to a let-binding). */
const symbolsIn = (node: unknown): string[] => {
  const s = symOf(node);
  if (s !== undefined) return [s];
  const p = asPair(node);
  if (!p) return [];
  return listOf(node).flatMap(symbolsIn);
};

/** The decision's DATA-input PRODUCERS: the invocations that computed the let-bound
 *  operands its test reads. A bare symbol `pair` or a compound `(> score 0.6)` both
 *  resolve through the enclosing lets to whichever invocation produced each operand.
 *
 *  Every operand value is, by construction, either rooted purely in literals (a
 *  STATIC operand — degenerate, no dataflow to draw) or derived directly/indirectly
 *  from an inference (then it ALWAYS carries that inference in its TRANSITIVE
 *  provenance). So the caller doesn't require the immediate producer to itself be a
 *  rendered point — it follows the producer's provenance back to the inference
 *  origin(s) and wires from THOSE. A plumbing producer (`(find-merge candidates)`)
 *  that derived from inferences thus still wires; a literal-only one wires nothing. */
const decisionInputProducers = (inv: PlainInv, valueById: (id: number) => unknown): { sym: string; producerId: number }[] => {
  const head = headOf(inv);
  if (head !== "if" && head !== "when" && head !== "unless") return [];
  const test = listOf(inv.node)[1];
  if (test === undefined) return [];
  const out: { sym: string; producerId: number }[] = [];
  const seen = new Set<string>();
  for (const sym of symbolsIn(test)) {
    if (seen.has(sym)) continue;
    seen.add(sym);
    const r = resolveRaw(inv, sym, valueById);
    if (r?.producerId !== undefined) out.push({ sym, producerId: r.producerId });
  }
  return out;
};

/** The rosetta heads of a DIRECT, user-written inference call. A provenance point
 *  whose head is one of these is a raw `(infer …)` / `(infer/chat …)`. Any OTHER
 *  provenance point is a `.prompt` proc — now an opaque native proc, so its
 *  invocation IS the `(run-x …)` call at the real source location (head = the
 *  binding `run-x`). The old line-1 lambda-unwrap heuristic is gone with it. */
const DIRECT_INFER_HEADS: ReadonlySet<string> = new Set(["infer", "infer/chat"]);

/** Classify an infer provenance point by its head: a direct `(infer/chat …)` →
 *  `direct`, labelled by the rosetta head; a `.prompt` call `(run-x …)` →
 *  `prompt`, labelled by the binding `run-x` at its real source location. */
function leafFor(inv: PlainInv): Extract<Region, { kind: "leaf" }> {
  const head = headOf(inv);
  return {
    kind: "leaf",
    id: inv.id,
    label: head,
    scope: scopeId(inv.node),
    nodeKind: DIRECT_INFER_HEADS.has(head) ? "direct" : "prompt",
    meta: inv.metadata,
    value: inv.value,
    state: inv.state,
  };
}

/** A non-structural application that recurs on its own ancestor chain — the same
 *  loop-detection `traceToForest` uses (a recursive APPLICATION, not a re-entrant
 *  special form). `let`/`if`/`begin` re-enter every iteration, so they're excluded. */
const hasSelfAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

export function traceToRegions(trace: EvalTrace): RegionGraph {
  const snap = snapshotTrace(trace);
  const points = snap.invocations.filter((i) => i.isProvenancePoint);
  const pointIds = new Set(points.map((p) => p.id));

  // Live-value accessor for decision-operand substitution. The snapshot drops values
  // for plumbing, but a decision's operands are bound by enclosing lets whose
  // value-invocations ARE plumbing — we read those few values live, memoized, paying
  // the MobX/`lipsToJs` cost only for operands a decision actually references.
  const liveById = new Map<number, { value: unknown }>();
  for (const rec of trace.records.values()) for (const inv of rec.bindings) liveById.set(inv.id, inv);
  const valCache = new Map<number, unknown>();
  const valueById = (id: number): unknown => {
    if (valCache.has(id)) return valCache.get(id);
    const v = lipsToJs(liveById.get(id)?.value);
    valCache.set(id, v);
    return v;
  };

  // Wires: upstream(X) = ⋃ over X's children of child.provenance, ∩ points.
  // Provenance accumulates TRANSITIVELY (a value carries every ancestor point it
  // ever flowed through), so this raw set is a near-complete DAG — O(points²)
  // wires, almost all of them implied by a shorter path. On a real trace that's
  // thousands of edges over ~100 points, and ELK's layered crossing-minimization
  // is superlinear in edge count → the render stalls. Reduce to the Hasse diagram
  // (transitive reduction): keep u→x only when no OTHER upstream w of x already
  // reaches u (u→…→w→x makes the direct u→x redundant). The skeleton that's left
  // is the genuine causal structure, and it lays out fast.
  // Field points (`(:verdict obj)`, `(:next obj)` — KEYWORD_ACCESSOR_FIELD invocations)
  // carry provenance but are NOT rendered leaves: they're a field pluck off a real
  // producer. A consumer that reads `(:verdict (car reactions))` has the FIELD point
  // in its provenance, not the react infer directly — so naively `∩ points` drops it
  // and the producer→consumer wire vanishes (every reflect ended up isolated). Resolve
  // each id to its concrete origin: follow `fieldPointMeta` to the underlying producer,
  // chasing chains (`:verdict` of a `:next` of an infer → the infer). THIS is what
  // restores the in-block react→reflect dataflow.
  // Memoized: with transitive provenance the SAME id appears across O(points²)
  // provenance entries, so chasing its `fieldPointMeta` chain each time dominated
  // the build (profiled at ~50% of region construction). The resolution is a pure
  // function of the id; cache it so each id's chain is walked at most once.
  const originCache = new Map<number, number>();
  const resolveOrigin = (id: number): number => {
    const cached = originCache.get(id);
    if (cached !== undefined) return cached;
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const meta = snap.fieldPointMeta.get(cur);
      if (!meta) break;
      cur = meta.origin;
    }
    originCache.set(id, cur);
    return cur;
  };
  const upstreamOf = new Map<number, Set<number>>();
  for (const x of points) {
    const up = new Set<number>();
    for (const c of x.children)
      for (const p of c.provenance) {
        const o = resolveOrigin(p);
        if (o !== x.id && pointIds.has(o)) up.add(o);
      }
    upstreamOf.set(x.id, up);
  }
  // Ascending id is a valid topological order — a point's id is minted after every
  // point it can depend on — so each node's reachable-ancestor closure is complete
  // before any consumer reads it. `reach[x]` = all ancestors reachable from x.
  const EMPTY: ReadonlySet<number> = new Set();
  const reach = new Map<number, Set<number>>();
  const edges: { from: number; to: number; field?: string; kind: "data" | "control" }[] = [];
  for (const x of [...pointIds].sort((a, b) => a - b)) {
    const up = upstreamOf.get(x) ?? EMPTY;
    const closure = new Set<number>();
    for (const u of up) {
      closure.add(u);
      for (const a of reach.get(u) ?? EMPTY) closure.add(a);
    }
    for (const u of up) {
      // u→x is redundant iff another upstream w of x already reaches u.
      let redundant = false;
      for (const w of up) {
        if (w !== u && (reach.get(w) ?? EMPTY).has(u)) { redundant = true; break; }
      }
      if (!redundant) edges.push({ from: u, to: x, kind: "data" });
    }
    reach.set(x, closure);
  }

  // Recursive-function heads (loops), unioned from two readers. The STATIC AST
  // scan knows a function loops the moment it's defined — so a streaming loop is a
  // container from iteration 0, before its async-infer successor fires (without
  // this, gepa's `evolve` only boxes at the very end, reshaping the graph mid-run).
  // The DYNAMIC scan (`hasSelfAncestor`) catches anything the static reader misses.
  const recursiveHeads = staticRecursiveHeads(snap.invocations);
  for (const inv of snap.invocations) {
    if (STRUCTURAL_FORMS.has(headOf(inv))) continue;
    if (hasSelfAncestor(inv)) recursiveHeads.add(headOf(inv));
  }

  // Loop BODY scopes — the Pair a recursive fn evaluates each call, entered ×K.
  // We box the body (NOT the call site) so the top-level call and the in-body
  // recursive call — DIFFERENT Pairs — both feed the one container (forest's
  // trick). The forest's rule adds the body Pair when a re-entrant body sits
  // under a recursive call; storing Pairs means the first, non-re-entrant body
  // entry joins by identity too.
  // Loop body scopes from TWO sources. The STATIC set is the exact body Pairs of
  // statically-recursive defines — present from iteration 0, so the container shows
  // midway (not only on completion) WITHOUT mis-tagging the recursive call's own
  // argument evaluations as bodies. The DYNAMIC rule (parent is a recursive call
  // AND the body has already re-entered) covers loops the static reader can't see
  // (mutual recursion); it only fires once recursion is underway, which is fine —
  // those weren't streaming-stalled.
  const loopBodies = staticLoopBodyScopes(snap.invocations);
  for (const inv of snap.invocations) {
    if (inv.parent && hasSelfAncestor(inv) && recursiveHeads.has(headOf(inv.parent))) {
      loopBodies.add(inv.node as object);
    }
  }
  // The spine walk is SAME-LOOP-scoped, keyed on the body AST node identity: every
  // iteration of ONE loop re-enters the SAME body Pair (the source AST is shared
  // across trampoline bounces), so a loop is the chain of invocations carrying that
  // exact node. Matching "any loop body" instead breaks the moment a loop body
  // nests ANOTHER loop (gepa's `evolve` body runs `sample-batch` and `find-merge`,
  // both recursive): the walk would jump into the inner loop and cut `evolve`'s own
  // per-iteration work. Node-identity keeps each loop on its own spine, and a nested
  // DIFFERENT loop simply renders as its own container inside the iteration.
  //
  // Re-entry of the SAME loop (an ancestor shares this body's node) → a later
  // iteration the entry already owns; cut it (return [] at the entry guard).
  const hasSameBodyAncestor = (inv: PlainInv): boolean => {
    for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
    return false;
  };
  // The SAME loop's next iteration: shallowest descendant re-entering THIS body
  // node. Early-return DFS, so summed over the spine the walk is O(N), not O(N²).
  const nextSameBody = (entry: PlainInv): PlainInv | undefined => {
    const find = (n: PlainInv): PlainInv | undefined => {
      for (const c of n.children) {
        if (c.node === entry.node) return c;
        const deep = find(c);
        if (deep) return deep;
      }
      return undefined;
    };
    return find(entry);
  };

  // LIVE-BRANCH detection. A branch form `(if …)`/`(cond …)`/… earns a `<>`
  // decision marker only when its SOURCE-LOCATION scope took ≥2 distinct routes
  // across the whole trace — i.e. it actually decided differently at least once.
  // The "route" a single branch invocation took is the identity of its LAST
  // evaluated child's node: evaluation order puts the test(s) first and the chosen
  // arm/body last, so the last child IS the taken arm (or the test itself when the
  // arm was a bare atom with no sub-invocation — still a distinct route from an
  // inference-bearing arm: "sometimes ran the infer arm, sometimes didn't"). One
  // distinct route ⇒ the branch always went the same way ⇒ seamless plumbing.
  //
  // No loop-control exclusion: a recursive fn's tail `if` (recurse vs base-case)
  // that IS the loop body is already claimed by the loop CONTAINER (the loopBodies
  // case runs before branch handling), so it never reaches the marker. The OTHER
  // control branches inside a loop body (genetic-vs-reflective, gate pass/fail) ARE
  // the midway decisions we want to mark — a marker doesn't box, so there's nothing
  // to double-draw even when an arm routes onward to the recursive call.
  const BRANCH_VOID: object = Symbol("branch-route-void") as unknown as object;
  const routeOf = (inv: PlainInv): object => (inv.children.length > 0 ? inv.children[inv.children.length - 1]!.node : BRANCH_VOID);
  const branchRoutes = new Map<string, Set<object>>();
  for (const inv of snap.invocations) {
    if (!BRANCH_FORMS.has(headOf(inv))) continue;
    const scope = scopeId(inv.node);
    (branchRoutes.get(scope) ?? branchRoutes.set(scope, new Set()).get(scope)!).add(routeOf(inv));
  }
  const liveBranchScopes = new Set<string>();
  for (const [scope, routes] of branchRoutes) {
    if (routes.size >= 2) liveBranchScopes.add(scope);
  }

  // `<>` knot id → the chosen arm's RESULT leaf id, collected during the walk. A
  // branch returns its taken arm's value, and `regionsAt` emits that arm's own leaf
  // LAST (eval order: test first, chosen value last) — so the final leaf in a knot's
  // inner regions is the producer whose value the branch yielded. We seat the knot at
  // the head of that producer's flow once the walk is done.
  const knotArm: { knot: number; arm: number }[] = [];
  // The arm a knot routes to is the LAST region its inner walk emitted (eval order:
  // test first, chosen value last) — regardless of kind. Taking only `leaf` floated
  // every knot whose arm was a fanout/recursion (gepa's `if@291`/`if@293`): the arm
  // had no bare leaf, so the control wire dangled. Last-of-any-kind seats the knot at
  // the head of whatever the arm actually produced (a leaf, a fanout, a nested knot).
  const lastRegionId = (rs: Region[]): number | undefined => (rs.length > 0 ? rs[rs.length - 1]!.id : undefined);
  // Decision data-inputs collected during the walk: knot id → operand producer ids.
  const knotInputs: { knot: number; from: number }[] = [];

  const regionsAt = (inv: PlainInv): Region[] => {
    if (inv.isProvenancePoint) {
      // A point is an ATOMIC card — but its ARGUMENT subtree can hold OTHER points
      // (a nested `(infer …)`) or a live branch (`… :failures (list (pick n)))`).
      // Those carry the very provenance that wires INTO this consumer, so if we
      // returned the bare leaf they'd never render and their edges would dangle
      // from nothing. HOIST them as PRECEDING siblings: the producers a card
      // depends on draw before it, the card itself stays atomic, and every wire
      // lands on a rendered node. (The point's OWN value still flows downstream
      // via its leaf id, unchanged.)
      const hoisted = inv.children.flatMap(regionsAt);
      return [...hoisted, leafFor(inv)];
    }

    if (loopBodies.has(inv.node as object)) {
      // A re-entrant body (an ancestor is the same loop's body) is the next
      // iteration; the loop ENTRY's spine walk owns it. Reached via flatten →
      // CUT, so the next iteration's body doesn't leak into this one.
      if (hasSameBodyAncestor(inv)) return [];

      // Loop ENTRY (the first body entry) → one fanout container; iterations =
      // the spine of body entries, each cut at the next. The recursive call's
      // arg eval (the `reflect` that seeds the next iteration) lives OUTSIDE the
      // next body, so it stays in THIS iteration — correct: this iteration
      // computed it. Sequential iters reuse `fanout` (Z-tabs) per V's call.
      const iterations: Region[][] = [];
      let incoming = 0;
      for (let body: PlainInv | undefined = inv; body; body = nextSameBody(body)) {
        incoming += 1;
        const regions = body.children.flatMap(regionsAt);
        if (regions.length > 0) iterations.push(regions);
      }
      // Degenerate container (no inference anywhere in the loop) → drop it. The
      // cleanup is INLINE: an empty fanout never materializes, so an outer frame
      // whose only child was this loop also flattens to nothing and collapses too.
      if (iterations.length === 0) return [];
      // Label by the recursive fn name (the call head, e.g. `loop`), not the
      // body form (`let`).
      const label = inv.parent ? headOf(inv.parent) : headOf(inv);
      return [{ kind: "fanout", id: inv.id, stages: [{ label, id: inv.id }], iterations, incoming, loop: true, inputs: [], outputs: [] }];
    }

    if (FANOUT.has(headOf(inv))) {
      // Iterations = the application children (those carrying a body). The
      // eval'd-once args (lambda, collection) have no children → excluded.
      const applChildren = inv.children.filter((c) => c.children.length > 0);
      // An iteration that flattens to nothing meaningful is dropped; `incoming`
      // keeps the RAW count so the banner can say "10 incoming, 5 mattered".
      const iterations = applChildren.map((c) => regionsAt(c)).filter((r) => r.length > 0);
      // Degenerate container (mapped/filtered over non-inference data) → drop it.
      if (iterations.length === 0) return [];
      return [{ kind: "fanout", id: inv.id, stages: [{ label: headOf(inv), id: inv.id }], iterations, incoming: applChildren.length, inputs: [], outputs: [] }];
    }

    // A LIVE branch (decided ≥2 ways trace-wide) does NOT box — boxing every `if`
    // makes branches dominate and shatters a TCO loop whose body IS an `if` into a
    // nested tower of boxes (the loop never peels). Instead drop a `<>` DECISION
    // MARKER at the site and flatten through to the arm it took: the divergence is
    // already carried by the enclosing autonomous region's iteration picker, so the
    // marker just says "here's where the decision was made". An arm with no rendered
    // content this time (a bare-atom route) yields nothing → no marker either.
    // (A branch that IS a loop body was already claimed above; a seamless one-way
    // branch isn't live and falls through to plain plumbing.)
    if (BRANCH_FORMS.has(headOf(inv)) && liveBranchScopes.has(scopeId(inv.node))) {
      const inner = inv.children.flatMap(regionsAt);
      if (inner.length === 0) return [];
      // Data-in: each operand traces (through plumbing) to the inference(s) that
      // produced it. Follow the operand back to its inference origin(s) and wire those
      // into the decision — a literal-rooted operand resolves to none (static, nothing
      // to draw). The provenance rides on the operand's VALUE (an AValue), not on its
      // producer invocation: a field-pluck like `(:verdict (car (infer …)))` leaves the
      // `:verdict` invocation's own provenance empty but stamps the plucked AValue with
      // the field point that resolves back to the infer. Read it live (`liveById`); the
      // snapshot drops plumbing values, but the live trace keeps them.
      //
      // An operand that resolves to ≥1 inference origin is WIRED: its value arrives on a
      // data wire, so the pill shows only its name (the value lives at the wire source).
      const wired = new Set<string>();
      const inputs: number[] = [];
      for (const { sym, producerId } of decisionInputProducers(inv, valueById)) {
        const origins = pointIds.has(producerId)
          ? [producerId]
          : [...valueProvenance(liveById.get(producerId)?.value)].map(resolveOrigin).filter((o) => pointIds.has(o));
        if (origins.length === 0) continue;
        wired.add(sym);
        inputs.push(...origins);
      }
      // DYNAMIC-PROVENANCE GATE (V's rule): a decision renders only when its outcome is
      // genuinely INDETERMINATE from the trace's dynamic data — i.e. at least one tested
      // operand traces back to an inference. A purely static test (`(if #t …)`, a
      // literal-only comparison `{10 + 20 < 50}`, a pool-shape guard like `pair`) is
      // degenerate: its result was fixed before the run, so it carries no decision the
      // reader can act on. Dissolve it — flatten to the gated work, no marker, no control
      // arm. We could only decide it because nothing inferred fed it; that's the tell.
      if (wired.size === 0) return inner;
      const arm = lastRegionId(inner);
      if (arm !== undefined) knotArm.push({ knot: inv.id, arm });
      for (const from of inputs) knotInputs.push({ knot: inv.id, from });
      return [{ kind: "decision", id: inv.id, label: headOf(inv), scope: scopeId(inv.node), condition: conditionOf(inv, valueById, wired) }, ...inner];
    }

    return inv.children.flatMap(regionsAt); // plumbing: flatten through
  };

  // Consumer-field attribution (DERIVED, render-only-grade — never stored). For a
  // `.prompt` consumer, find which named input the producer flowed into.
  //
  // SOUND path (`inputsProvenance`): the rosetta membrane threaded each input's
  // DEEP provenance (per-element origins, not the value itself) through to the
  // node's metadata. The producer `e.from` flowed into field `k` iff k's
  // origin-resolved provenance closure contains it. This survives packing into a
  // list — `(list react.verdict …)` keeps each element's origin — where a
  // whole-value compare would only ever see the array, not its sources. Precise
  // because the edges are Hasse-reduced (immediate producers only), so a transitive
  // ancestor in the same closure can't steal the attribution.
  //
  // FALLBACK (structural value match): older traces with no `inputsProvenance`.
  // Match the producer's resolved value against the consumer's `inputs` dict by
  // stable JSON. Declines (leaves `field` unset) when the slot holds a PROJECTION
  // rather than the value — the honest "this input is a transform, not the source".
  const pointById = new Map(points.map((p) => [p.id, p]));
  const asJson = (v: unknown): string | undefined => {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  };
  // A producer's value can land in MORE THAN ONE of a consumer's slots — a template
  // `message: is ${score} fair for ${result}` reads both `score` and `result`, and
  // the same producer can feed two distinct slots of the same `.prompt`. The Hasse
  // edge from that producer to that consumer is ONE structural fact, but it carries
  // SEVERAL field-to-field flows. So we don't label the edge with one field and stop
  // (`break`) — that collapses N real flows into one arbitrary wire. Instead each
  // (producer, slot) pair becomes its OWN field-qualified edge, and a producer that
  // feeds two slots draws two wires landing on two consumer field-rows. An edge whose
  // producer feeds no named slot (or a pre-`inputsProvenance` trace) stays a single
  // unlabeled edge via the structural-value fallback.
  const fieldEdges: typeof edges = [];
  for (const e of edges) {
    const consumer = pointById.get(e.to);
    const meta = consumer?.metadata as
      | { kind?: string; inputs?: Record<string, unknown>; inputsProvenance?: Record<string, number[]> }
      | undefined;
    if (!meta || meta.kind !== "prompt" || !meta.inputs) {
      fieldEdges.push(e);
      continue;
    }

    if (meta.inputsProvenance) {
      // Every slot this producer flowed into → its own field-qualified edge.
      const fields = Object.entries(meta.inputsProvenance)
        .filter(([, ids]) => ids.some((id) => resolveOrigin(id) === e.from))
        .map(([k]) => k);
      if (fields.length > 0) {
        for (const field of fields) fieldEdges.push({ ...e, field });
        continue;
      }
    }

    const producer = pointById.get(e.from);
    if (!producer || producer.value === undefined) {
      fieldEdges.push(e);
      continue;
    }
    const pv = asJson(producer.value);
    if (pv === undefined) {
      fieldEdges.push(e);
      continue;
    }
    let labeled = false;
    for (const [k, v] of Object.entries(meta.inputs)) {
      if (asJson(v) === pv) {
        fieldEdges.push({ ...e, field: k });
        labeled = true;
        break;
      }
    }
    if (!labeled) fieldEdges.push(e);
  }
  edges.length = 0;
  edges.push(...fieldEdges);

  const tops = snap.invocations.filter((i) => !i.parent);
  const roots = tops.flatMap(regionsAt);

  // Wire each `<>` knot to the arm it chose THIS run. A live branch is degenerate
  // WITHIN a single tab (one arm ran), so on its own the marker has no dataflow and
  // floats detached — but across the enclosing block's Z-tabs the SAME code point
  // took DIFFERENT arms, which is exactly what the knot exists to say. We surface
  // that by seating it at the HEAD of the chosen arm's flow: a single edge knot→arm
  // to the leaf the branch yielded this run (captured during the walk). The chain
  // then reads `<> → spark → digest` where the arm feeds downstream, and `<> → spark`
  // where it doesn't — a junction on the spaghetti instead of an orphan box. The
  // knot's id is the branch invocation id (never a provenance point), so it only
  // ever appears as an edge SOURCE here; nothing upstream targets it. Branch
  // invocations carry no materialized provenance (trace-snapshot only retains it for
  // children-of-points and roots), so we seat the knot via the arm's own leaf, not a
  // provenance scan.
  for (const { knot, arm } of knotArm) edges.push({ from: knot, to: arm, kind: "control" });

  // Data-in: each decision's operand producers feed the knot. This is the OTHER
  // spaghetti — "WHAT data the decision consumed" — distinct from the control wire
  // above ("WHICH arm the decision gated"). A decision thus reads as a junction that
  // CONSUMES data (inbound data edges) and PRODUCES a control signal (outbound control
  // edge to the arm). Deduped: the same producer can back two operands of one test.
  const seenInput = new Set<string>();
  for (const { knot, from } of knotInputs) {
    const key = `${from}->${knot}`;
    if (seenInput.has(key)) continue;
    seenInput.add(key);
    edges.push({ from, to: knot, kind: "data" });
  }

  // The program's STATEMENT OUTPUT — the value the LAST top-level expression
  // returned. Render it as a terminal node the graph flows into, but only when
  // there's a graph to terminate (some inference happened) and the final form
  // actually produced a value (not a trailing `define`). Wire it from its
  // IMMEDIATE producers: the provenance origins of the returned value, Hasse-
  // reduced against each other so only the last region(s) it came from connect —
  // the same transitive-reduction the dataflow edges use.
  const OUTPUT_ID = -1;
  const final = tops[tops.length - 1];
  if (roots.length > 0 && final && final.value !== undefined) {
    const origins = new Set<number>();
    for (const p of final.provenance) {
      const o = resolveOrigin(p);
      if (pointIds.has(o)) origins.add(o);
    }
    for (const o of origins) {
      const redundant = [...origins].some((w) => w !== o && (reach.get(w) ?? EMPTY).has(o));
      if (!redundant) edges.push({ from: o, to: OUTPUT_ID, kind: "data" });
    }
    roots.push({ kind: "output", id: OUTPUT_ID, value: final.value, state: final.state });
  }

  // ── Stage 2a: regions ARE boxes — populate each container's boundary ports ────
  // Pure edge-vs-membership over the region tree we just built (no recompute, no
  // forest/scope-id round-trip): walk the tree to learn, for every region id, which
  // fanout containers enclose it and (for leaves/decisions) its structural scope.
  // Then an edge `from→to` is an INPUT of every container holding `to` but not
  // `from`, and an OUTPUT of every container holding `from` but not `to` — keyed by
  // the producer's scope so a body that ran N times contributes ONE port, not N.
  const enclosing = new Map<number, number[]>(); // region id → enclosing fanout ids (outer→inner)
  const scopeById = new Map<number, string>(); // leaf/decision id → structural scope-id
  const fanoutById = new Map<number, Extract<Region, { kind: "fanout" }>>();
  const walkPorts = (regions: Region[], ancestors: number[]): void => {
    for (const r of regions) {
      enclosing.set(r.id, ancestors);
      if (r.kind === "leaf" || r.kind === "decision") scopeById.set(r.id, r.scope);
      if (r.kind === "fanout") {
        fanoutById.set(r.id, r);
        const inner = [...ancestors, r.id];
        for (const iter of r.iterations) walkPorts(iter, inner);
      }
    }
  };
  walkPorts(roots, []);

  // Per-container port accumulators, deduped by `producer-scope | field`.
  const inPorts = new Map<number, Map<string, RegionPort>>();
  const outPorts = new Map<number, Map<string, RegionPort>>();
  const addPort = (
    table: Map<number, Map<string, RegionPort>>,
    container: number,
    producer: string,
    field?: string,
  ): void => {
    const ports = table.get(container) ?? table.set(container, new Map()).get(container)!;
    const key = `${producer}|${field ?? ""}`;
    if (!ports.has(key)) ports.set(key, field === undefined ? { producer } : { producer, field });
  };
  for (const e of edges) {
    const producer = scopeById.get(e.from);
    if (producer === undefined) continue; // output terminal etc. — not a structural producer
    const fromAnc = new Set(enclosing.get(e.from) ?? []);
    const toAnc = new Set(enclosing.get(e.to) ?? []);
    for (const c of toAnc) if (!fromAnc.has(c)) addPort(inPorts, c, producer, e.field); // crosses IN
    for (const c of fromAnc) if (!toAnc.has(c)) addPort(outPorts, c, producer, e.field); // crosses OUT
  }
  const sortPorts = (ports: Map<string, RegionPort> | undefined): RegionPort[] =>
    [...(ports?.values() ?? [])].sort((a, b) => (a.producer === b.producer ? (a.field ?? "").localeCompare(b.field ?? "") : a.producer.localeCompare(b.producer)));
  for (const [id, fanout] of fanoutById) {
    fanout.inputs = sortPorts(inPorts.get(id));
    fanout.outputs = sortPorts(outPorts.get(id));
  }

  return { roots, edges, warnings: [] };
}
