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
 *
 * ── from-scratch vs incremental ───────────────────────────────────────────────
 * `traceToRegions(trace)` is the from-scratch build: `buildRegions(snapshotTrace(t), t)`.
 * The trace is APPEND-ONLY (pure interpreter, no retraction), so `TraceRegionFold`
 * (`trace-region-fold.ts`) maintains the SAME RegionGraph incrementally — O(Δ-new-
 * invocations) per tick, not O(N) per call. Parity is enforced by a strict deep-equal
 * test (`__tests__/trace-region-fold.test.ts`): the fold reuses the EXACT pure helpers
 * this module exports (`leafFor`, `conditionOf`, `decisionInputProducers`,
 * `addPointToHasse`, `regionsAt`, `attributeFieldEdges`, `derivePorts`, …) rather than
 * re-deriving them, so the two paths cannot drift.
 */
import { lipsToJs } from "@here.build/arrival-scheme";
import { snapshotTrace, type PlainInv, type PlainTrace } from "./trace-snapshot.js";
import { schemeToSweet } from "@here.build/arrival-sweet";
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
      /** Stable STRUCTURAL identity (`head@line:col`) of the fanout's call site — the
       *  same string for every iteration of an OUTER container this fanout is nested in,
       *  exactly as `leaf.scope`/`decision.scope` are. The fanout's `id` is a per-pass
       *  runtime invocation id, so it CANNOT key the cross-pass fold: a nested `(map …)`
       *  run once per outer persona gets a fresh `id` each pass and would never
       *  consolidate. Keying the render fold by `scope` folds all those passes onto one
       *  container node (the matryoshka fix). */
      scope: string;
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
  /** `fromField` marks a field-PLUCK: the consumer read only a SUBSET of the
   *  producer's fields (`(:verdict (infer …))`) rather than the whole value. Its
   *  presence tells the renderer to draw a granular per-field wire into that slot
   *  instead of absorbing the producer's whole result — the produced value isn't
   *  what lands in the slot, one of its fields is. Currently un-emitted: the seam
   *  the field-pluck derivation drops into (a separate follow-up); the consumer
   *  guards (`if (e.fromField !== undefined) continue`) already honor it. */
  edges: { from: number; to: number; field?: string; fromField?: string; kind: "data" | "control" }[];
  warnings: string[];
}

export type RegionEdge = RegionGraph["edges"][number];

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
export const conditionOf = (
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
 *  structurally to avoid importing AValue here; a literal/unstamped value yields none.
 *  Exported so `TraceRegionFold` can compute a branch's "dynamic-capable" predicate with
 *  the EXACT same logic `regionsAt` uses (parity of the wired-operand test). */
export const valueProvenance = (v: unknown): Iterable<number> => {
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
export const decisionInputProducers = (inv: PlainInv, valueById: (id: number) => unknown): { sym: string; producerId: number }[] => {
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
export function leafFor(inv: PlainInv): Extract<Region, { kind: "leaf" }> {
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

// ── shared origin resolution (field-point → producer) ─────────────────────────
/** Resolve a (possibly field-point) id to its concrete producer origin, chasing the
 *  `fieldPointMeta` chain (`:verdict` of a `:next` of an infer → the infer). Memoized
 *  via `cache`; pure in `fieldPointMeta`, so the cache is sound across the build (and
 *  across incremental ticks — `fieldPointMeta` only grows, never rewrites an entry). */
export function resolveOriginVia(
  id: number,
  fieldPointMeta: PlainTrace["fieldPointMeta"],
  cache: Map<number, number>,
): number {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  let cur = id;
  for (let guard = 0; guard < 64; guard++) {
    const meta = fieldPointMeta.get(cur);
    if (!meta) break;
    cur = meta.origin;
  }
  cache.set(id, cur);
  return cur;
}

const EMPTY: ReadonlySet<number> = new Set();

/** ONE point's contribution to the Hasse (transitive-reduction) edge set, in ascending
 *  id order. `up` = x's in-graph upstream origins (already origin-resolved + ∩ points).
 *  Appends the non-redundant `u→x` edges and records `reach[x]` (x's full ancestor
 *  closure). Ascending id is a valid topological order, so a new point only ADDS edges
 *  and never invalidates an existing one — which is exactly what lets `TraceRegionFold`
 *  call this per new point and keep `edges`/`reach` identical to the from-scratch build.
 *  Returns the edges it appended (the caller pushes them into the shared list). */
export function addPointToHasse(
  x: number,
  up: ReadonlySet<number>,
  reach: Map<number, Set<number>>,
): { edges: RegionEdge[]; closure: Set<number> } {
  const closure = new Set<number>();
  for (const u of up) {
    closure.add(u);
    for (const a of reach.get(u) ?? EMPTY) closure.add(a);
  }
  const out: RegionEdge[] = [];
  for (const u of up) {
    // u→x is redundant iff another upstream w of x already reaches u.
    let redundant = false;
    for (const w of up) {
      if (w !== u && (reach.get(w) ?? EMPTY).has(u)) { redundant = true; break; }
    }
    if (!redundant) out.push({ from: u, to: x, kind: "data" });
  }
  reach.set(x, closure);
  return { edges: out, closure };
}

/** x's in-graph upstream origin set: ⋃ over x's children of child.provenance, each
 *  origin-resolved (field-point → producer) and kept iff it's a point and not x. */
export function upstreamOfPoint(
  x: PlainInv,
  pointIds: ReadonlySet<number>,
  fieldPointMeta: PlainTrace["fieldPointMeta"],
  originCache: Map<number, number>,
): Set<number> {
  const up = new Set<number>();
  for (const c of x.children)
    for (const p of c.provenance) {
      const o = resolveOriginVia(p, fieldPointMeta, originCache);
      if (o !== x.id && pointIds.has(o)) up.add(o);
    }
  return up;
}

// ── the region walk (regionsAt) — shared by from-scratch + incremental ─────────

/** A `route` token for a branch invocation — the identity of its LAST evaluated child's
 *  node (the taken arm), or the void sentinel when it had no sub-invocation. Equal
 *  routes ⇒ the branch went the same way; ≥2 distinct routes at one scope ⇒ a live
 *  branch (it decided differently at least once). */
const BRANCH_VOID: object = Symbol("branch-route-void") as unknown as object;
export const routeOf = (inv: PlainInv): object => (inv.children.length > 0 ? inv.children[inv.children.length - 1]!.node : BRANCH_VOID);

/** An OPTIONAL per-iteration memo hook (the incremental seam). `regionsAt` calls this
 *  at each iteration-producing site (a loop body-entry, a map appl-child) so that
 *  `TraceRegionFold` can REUSE a frozen iteration's already-built `Region[]` instead of
 *  re-walking its subtree — while the from-scratch build leaves it unset and recomputes
 *  everything. `freezable` is true iff the iteration's content can no longer change with
 *  trace growth (a loop iteration whose successor exists; a resolved map application);
 *  the hook may only cache when `freezable`. It MUST be transparent — return a value
 *  deep-equal to `compute()` — so parity holds whether it caches or not. */
export type IterationCache = (key: number, freezable: boolean, compute: () => Region[]) => Region[];

/** Everything `regionsAt` needs that is NOT the invocation itself — the global signal
 *  sets + value/point accessors + the per-walk collectors. Built fresh per from-scratch
 *  build; rebuilt (with cached membership) per incremental `current()`. */
export interface RegionWalkCtx {
  loopBodies: ReadonlySet<object>;
  liveBranchScopes: ReadonlySet<string>;
  pointIds: ReadonlySet<number>;
  valueById: (id: number) => unknown;
  /** Live value of an invocation id (for decision-operand provenance) — the snapshot
   *  drops plumbing values, so the decision path reads the live trace. */
  liveValueById: (id: number) => unknown;
  fieldPointMeta: PlainTrace["fieldPointMeta"];
  originCache: Map<number, number>;
  /** Collectors filled during the walk (knot→arm control wires, knot→operand data
   *  wires) — read after the walk to append the decision edges. */
  knotArm: { knot: number; arm: number }[];
  knotInputs: { knot: number; from: number }[];
  /** Incremental memo seam (unset for from-scratch). See {@link IterationCache}. */
  iterationCache?: IterationCache;
  /** OPTIONAL cached loop spine (the incremental win for TCO loops). Given a loop ENTRY
   *  invocation, returns its full ordered list of body-entries — so the walk does NOT
   *  re-DFS the whole recursion via `nextSameBody` each `current()` (which is O(N) — the
   *  per-iteration subtree contains the next entry deep inside, so re-finding it each pass
   *  re-scans every iteration). `TraceRegionFold` maintains this in O(Δ); from-scratch
   *  leaves it unset and walks `nextSameBody` directly. The returned spine MUST be the
   *  SAME chain `nextSameBody` would produce (entry, nextSameBody(entry), …) for parity. */
  loopSpine?: (entry: PlainInv) => PlainInv[];
}

const hasSameBodyAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

/** The SAME loop's next iteration: shallowest descendant re-entering THIS body node.
 *  Early-return DFS, so summed over a spine the walk is O(N), not O(N²). */
export const nextSameBody = (entry: PlainInv): PlainInv | undefined => {
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

/** The full body-entry spine of a loop, from `entry` via `nextSameBody`. The from-scratch
 *  enumeration (the incremental path supplies an equal cached list via `ctx.loopSpine`). */
export const walkSpine = (entry: PlainInv): PlainInv[] => {
  const out: PlainInv[] = [];
  for (let body: PlainInv | undefined = entry; body; body = nextSameBody(body)) out.push(body);
  return out;
};

const lastRegionId = (rs: Region[]): number | undefined => (rs.length > 0 ? rs[rs.length - 1]!.id : undefined);

/**
 * Walk one invocation into its meaningful regions — the SINGLE source of region-tree
 * truth, shared by `buildRegions` (from-scratch) and `TraceRegionFold.current()`
 * (incremental). Pure given `ctx` + the invocation subtree; the only side effects are
 * appends to `ctx.knotArm` / `ctx.knotInputs` (the decision wires, read after the walk).
 */
export function regionsAt(inv: PlainInv, ctx: RegionWalkCtx): Region[] {
  if (inv.isProvenancePoint) {
    // A point is an ATOMIC card — but its ARGUMENT subtree can hold OTHER points
    // (a nested `(infer …)`) or a live branch (`… :failures (list (pick n)))`).
    // Those carry the very provenance that wires INTO this consumer, so if we
    // returned the bare leaf they'd never render and their edges would dangle
    // from nothing. HOIST them as PRECEDING siblings: the producers a card
    // depends on draw before it, the card itself stays atomic, and every wire
    // lands on a rendered node. (The point's OWN value still flows downstream
    // via its leaf id, unchanged.)
    const hoisted = inv.children.flatMap((c) => regionsAt(c, ctx));
    return [...hoisted, leafFor(inv)];
  }

  if (ctx.loopBodies.has(inv.node as object)) {
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
    // The spine of body-entries — from the cached list (incremental) or by walking
    // `nextSameBody` (from-scratch). IDENTICAL chains either way (parity contract).
    const spine = ctx.loopSpine ? ctx.loopSpine(inv) : walkSpine(inv);
    for (let i = 0; i < spine.length; i++) {
      const here = spine[i]!;
      incoming += 1;
      // A loop iteration is FROZEN once its successor body-entry exists: the `if` has
      // definitively routed to the recursive call and this iteration's content (work +
      // the recursive call's arg-eval that surfaces here) can no longer change. The
      // LAST entry (no successor yet) is the growth frontier — never cached.
      const frozen = i < spine.length - 1;
      const regions = ctx.iterationCache
        ? ctx.iterationCache(here.id, frozen, () => here.children.flatMap((c) => regionsAt(c, ctx)))
        : here.children.flatMap((c) => regionsAt(c, ctx));
      if (regions.length > 0) iterations.push(regions);
    }
    // Degenerate container (no inference anywhere in the loop) → drop it. The
    // cleanup is INLINE: an empty fanout never materializes, so an outer frame
    // whose only child was this loop also flattens to nothing and collapses too.
    if (iterations.length === 0) return [];
    // Label by the recursive fn name (the call head, e.g. `loop`), not the
    // body form (`let`).
    const label = inv.parent ? headOf(inv.parent) : headOf(inv);
    return [{ kind: "fanout", id: inv.id, scope: scopeId(inv.node), stages: [{ label, id: inv.id }], iterations, incoming, loop: true, inputs: [], outputs: [] }];
  }

  if (FANOUT.has(headOf(inv))) {
    // Iterations = the application children (those carrying a body). The
    // eval'd-once args (lambda, collection) have no children → excluded.
    const applChildren = inv.children.filter((c) => c.children.length > 0);
    // An iteration that flattens to nothing meaningful is dropped; `incoming`
    // keeps the RAW count so the banner can say "10 incoming, 5 mattered". A map
    // application is FROZEN once it has resolved (its subtree no longer grows —
    // map iterations are independent, unlike a loop spine), so the cache may reuse
    // it; a still-running application is the frontier and is recomputed each tick.
    const iterations = applChildren
      .map((c) => (ctx.iterationCache ? ctx.iterationCache(c.id, c.state !== "running", () => regionsAt(c, ctx)) : regionsAt(c, ctx)))
      .filter((r) => r.length > 0);
    // Degenerate container (mapped/filtered over non-inference data) → drop it.
    if (iterations.length === 0) return [];
    return [{ kind: "fanout", id: inv.id, scope: scopeId(inv.node), stages: [{ label: headOf(inv), id: inv.id }], iterations, incoming: applChildren.length, inputs: [], outputs: [] }];
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
  if (BRANCH_FORMS.has(headOf(inv)) && ctx.liveBranchScopes.has(scopeId(inv.node))) {
    const inner = inv.children.flatMap((c) => regionsAt(c, ctx));
    if (inner.length === 0) return [];
    // Data-in: each operand traces (through plumbing) to the inference(s) that
    // produced it. Follow the operand back to its inference origin(s) and wire those
    // into the decision — a literal-rooted operand resolves to none (static, nothing
    // to draw). The provenance rides on the operand's VALUE (an AValue), not on its
    // producer invocation: a field-pluck like `(:verdict (car (infer …)))` leaves the
    // `:verdict` invocation's own provenance empty but stamps the plucked AValue with
    // the field point that resolves back to the infer. Read it live (`liveValueById`);
    // the snapshot drops plumbing values, but the live trace keeps them.
    //
    // An operand that resolves to ≥1 inference origin is WIRED: its value arrives on a
    // data wire, so the pill shows only its name (the value lives at the wire source).
    const wired = new Set<string>();
    const inputs: number[] = [];
    for (const { sym, producerId } of decisionInputProducers(inv, ctx.valueById)) {
      const origins = ctx.pointIds.has(producerId)
        ? [producerId]
        : [...valueProvenance(ctx.liveValueById(producerId))]
            .map((p) => resolveOriginVia(p, ctx.fieldPointMeta, ctx.originCache))
            .filter((o) => ctx.pointIds.has(o));
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
    if (arm !== undefined) ctx.knotArm.push({ knot: inv.id, arm });
    for (const from of inputs) ctx.knotInputs.push({ knot: inv.id, from });
    return [{ kind: "decision", id: inv.id, label: headOf(inv), scope: scopeId(inv.node), condition: conditionOf(inv, ctx.valueById, wired) }, ...inner];
  }

  return inv.children.flatMap((c) => regionsAt(c, ctx)); // plumbing: flatten through
}

// ── field-edge attribution (consumer-field, DERIVED render-only) ───────────────

/** Everything the field-attribution + output + port phases need. */
export interface FinalizeCtx {
  points: PlainInv[];
  pointIds: ReadonlySet<number>;
  reach: Map<number, Set<number>>;
  fieldPointMeta: PlainTrace["fieldPointMeta"];
  originCache: Map<number, number>;
}

/**
 * Rewrite the base point→point data edges into FIELD-QUALIFIED edges (consumer-field
 * attribution). For a `.prompt` consumer, find which named input the producer flowed
 * into — the sound `inputsProvenance` path (immediate-writer Hasse-reduced per slot +
 * value-presence gate) with a structural-value-match fallback. Returns the rewritten
 * edge list (the same edges, some now carrying `field`, some split into per-slot
 * copies). Pure given `ctx`; identical for from-scratch + incremental.
 */
export function attributeFieldEdges(edges: RegionEdge[], ctx: FinalizeCtx): RegionEdge[] {
  const { points, pointIds, reach } = ctx;
  const pointById = new Map(points.map((p) => [p.id, p]));
  // Per-consumer, per-slot IMMEDIATE producers. For each slot, resolve its provenance
  // ids to in-graph origins, then drop any origin reachable from another origin in the
  // SAME slot (the global-edge Hasse rule applied within the slot) — what's left is the
  // slot's direct writer(s). Memoized per consumer id; the loop below visits a consumer
  // once per inbound edge.
  const immediateCache = new Map<number, Record<string, Set<number>>>();
  const immediateBySlot = (consumer: number, ip: Record<string, number[]>): Record<string, Set<number>> => {
    const cached = immediateCache.get(consumer);
    if (cached) return cached;
    const out: Record<string, Set<number>> = {};
    for (const [k, ids] of Object.entries(ip)) {
      const origins = new Set<number>();
      for (const id of ids) {
        const o = resolveOriginVia(id, ctx.fieldPointMeta, ctx.originCache);
        if (pointIds.has(o)) origins.add(o);
      }
      const immediate = new Set<number>();
      for (const o of origins) {
        let dominated = false;
        for (const o2 of origins) {
          if (o2 !== o && (reach.get(o2) ?? EMPTY).has(o)) { dominated = true; break; }
        }
        if (!dominated) immediate.add(o);
      }
      out[k] = immediate;
    }
    immediateCache.set(consumer, out);
    return out;
  };
  const asJson = (v: unknown): string | undefined => {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  };
  // VALUE-PRESENCE — the Where-vs-Why gate. `inputsProvenance` carries a slot's
  // influenced-BY provenance, but field-to-field wiring wants value-flowed-FROM: a
  // producer wires into slot k only if its value actually shows up in k's value.
  const unwrap = (v: unknown): unknown => (v != null && typeof (v as { valueOf?: () => unknown }).valueOf === "function" ? (v as { valueOf: () => unknown }).valueOf() : v);
  const valuePresent = (needle: unknown, hay: unknown, depth = 0): boolean => {
    if (depth > 6) return false;
    const n = unwrap(needle);
    const h = unwrap(hay);
    const nj = asJson(n);
    if (nj !== undefined && nj !== "null" && asJson(h) === nj) return true;
    if (Array.isArray(h)) return h.some((e) => valuePresent(n, e, depth + 1));
    if (h && typeof h === "object") return Object.values(h).some((e) => valuePresent(n, e, depth + 1));
    if (typeof h === "string" && typeof n === "string" && n.length > 0) return h.includes(n);
    return false;
  };
  const out: RegionEdge[] = [];
  for (const e of edges) {
    const consumer = pointById.get(e.to);
    const meta = consumer?.metadata as
      | { kind?: string; inputs?: Record<string, unknown>; inputsProvenance?: Record<string, number[]> }
      | undefined;
    if (!meta || meta.kind !== "prompt" || !meta.inputs) {
      out.push(e);
      continue;
    }

    if (meta.inputsProvenance) {
      const producerValue = pointById.get(e.from)?.value;
      const fields = Object.entries(immediateBySlot(e.to, meta.inputsProvenance))
        .filter(([k, origins]) => origins.has(e.from) && valuePresent(producerValue, meta.inputs?.[k]))
        .map(([k]) => k);
      if (fields.length > 0) {
        for (const field of fields) out.push({ ...e, field });
        continue;
      }
    }

    const producer = pointById.get(e.from);
    if (!producer || producer.value === undefined) {
      out.push(e);
      continue;
    }
    const pv = asJson(producer.value);
    if (pv === undefined) {
      out.push(e);
      continue;
    }
    let labeled = false;
    for (const [k, v] of Object.entries(meta.inputs)) {
      if (asJson(v) === pv) {
        out.push({ ...e, field: k });
        labeled = true;
        break;
      }
    }
    if (!labeled) out.push(e);
  }
  return out;
}

/** The OUTPUT_ID sentinel — the program's statement-output terminal node id. */
export const OUTPUT_ID = -1;

/** Append the program's STATEMENT-OUTPUT terminal node + its immediate-producer edges,
 *  when there's a graph to terminate and the final top-level form produced a value.
 *  Mutates `roots`/`edges` in place (matching the from-scratch order). */
export function appendOutput(roots: Region[], edges: RegionEdge[], final: PlainInv | undefined, ctx: FinalizeCtx): void {
  if (!(roots.length > 0 && final && final.value !== undefined)) return;
  const origins = new Set<number>();
  for (const p of final.provenance) {
    const o = resolveOriginVia(p, ctx.fieldPointMeta, ctx.originCache);
    if (ctx.pointIds.has(o)) origins.add(o);
  }
  for (const o of origins) {
    const redundant = [...origins].some((w) => w !== o && (ctx.reach.get(w) ?? EMPTY).has(o));
    if (!redundant) edges.push({ from: o, to: OUTPUT_ID, kind: "data" });
  }
  roots.push({ kind: "output", id: OUTPUT_ID, value: final.value, state: final.state });
}

/** Append the decision wires collected during the walk: knot→arm CONTROL edges, then
 *  the deduped operand→knot DATA edges. Mutates `edges` in place (from-scratch order). */
export function appendDecisionEdges(edges: RegionEdge[], knotArm: { knot: number; arm: number }[], knotInputs: { knot: number; from: number }[]): void {
  for (const { knot, arm } of knotArm) edges.push({ from: knot, to: arm, kind: "control" });
  const seenInput = new Set<string>();
  for (const { knot, from } of knotInputs) {
    const key = `${from}->${knot}`;
    if (seenInput.has(key)) continue;
    seenInput.add(key);
    edges.push({ from, to: knot, kind: "data" });
  }
}

/** Stage 2a — populate each fanout container's boundary ports by pure edge-vs-membership
 *  over the region tree. Mutates the fanout regions' `inputs`/`outputs` in place. */
export function derivePorts(roots: Region[], edges: RegionEdge[]): void {
  const enclosing = new Map<number, number[]>(); // region id → enclosing fanout ids (outer→inner)
  const scopeById = new Map<number, string>(); // leaf/decision id → structural scope-id
  const fanoutById = new Map<number, Extract<Region, { kind: "fanout" }>>();
  const walk = (regions: Region[], ancestors: number[]): void => {
    for (const r of regions) {
      enclosing.set(r.id, ancestors);
      if (r.kind === "leaf" || r.kind === "decision") scopeById.set(r.id, r.scope);
      if (r.kind === "fanout") {
        fanoutById.set(r.id, r);
        const inner = [...ancestors, r.id];
        for (const iter of r.iterations) walk(iter, inner);
      }
    }
  };
  walk(roots, []);

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
}

/** Union the static + dynamic recursive-function heads / loop-body scopes (the two
 *  readers `traceToForest` uses). Pure over the invocation list; the fold extends the
 *  same sets incrementally. */
export function recursionSignals(invocations: PlainInv[]): { recursiveHeads: Set<string>; loopBodies: Set<object> } {
  const recursiveHeads = staticRecursiveHeads(invocations);
  for (const inv of invocations) {
    if (STRUCTURAL_FORMS.has(headOf(inv))) continue;
    if (hasSelfAncestor(inv)) recursiveHeads.add(headOf(inv));
  }
  const loopBodies = staticLoopBodyScopes(invocations);
  for (const inv of invocations) {
    if (inv.parent && hasSelfAncestor(inv) && recursiveHeads.has(headOf(inv.parent))) {
      loopBodies.add(inv.node as object);
    }
  }
  return { recursiveHeads, loopBodies };
}

/** Branch-route liveness: a `(if …)`/`(cond …)`/… scope is LIVE (earns a `<>` marker)
 *  iff it took ≥2 distinct routes across the trace. Returns both the per-scope route
 *  multiset (so the fold can extend it) and the derived live-scope set. */
export function branchLiveness(invocations: PlainInv[]): { branchRoutes: Map<string, Set<object>>; liveBranchScopes: Set<string> } {
  const branchRoutes = new Map<string, Set<object>>();
  for (const inv of invocations) {
    if (!BRANCH_FORMS.has(headOf(inv))) continue;
    const scope = scopeId(inv.node);
    (branchRoutes.get(scope) ?? branchRoutes.set(scope, new Set()).get(scope)!).add(routeOf(inv));
  }
  const liveBranchScopes = new Set<string>();
  for (const [scope, routes] of branchRoutes) {
    if (routes.size >= 2) liveBranchScopes.add(scope);
  }
  return { branchRoutes, liveBranchScopes };
}

/**
 * The from-scratch region build over a (pre-computed) snapshot. `traceToRegions` is
 * exactly `buildRegions(snapshotTrace(trace), trace)`; `TraceRegionFold` reuses the SAME
 * pure helpers above to maintain this output incrementally. Kept structurally identical
 * to the original single-function build so the deep-equal parity test holds.
 */
export function buildRegions(snap: PlainTrace, trace: EvalTrace): RegionGraph {
  const points = snap.invocations.filter((i) => i.isProvenancePoint);
  const pointIds = new Set(points.map((p) => p.id));

  // Live-value accessor for decision-operand substitution (memoized; pays the
  // MobX/`lipsToJs` cost only for operands a decision actually references).
  const liveById = new Map<number, { value: unknown }>();
  for (const rec of trace.records.values()) for (const inv of rec.bindings) liveById.set(inv.id, inv);
  const valCache = new Map<number, unknown>();
  const valueById = (id: number): unknown => {
    if (valCache.has(id)) return valCache.get(id);
    const v = lipsToJs(liveById.get(id)?.value);
    valCache.set(id, v);
    return v;
  };
  const liveValueById = (id: number): unknown => liveById.get(id)?.value;

  // Edges (Hasse transitive reduction) over the points, in ascending id order.
  const originCache = new Map<number, number>();
  const reach = new Map<number, Set<number>>();
  const edges: RegionEdge[] = [];
  for (const x of [...points].sort((a, b) => a.id - b.id)) {
    const up = upstreamOfPoint(x, pointIds, snap.fieldPointMeta, originCache);
    const { edges: added } = addPointToHasse(x.id, up, reach);
    edges.push(...added);
  }

  // Recursion + branch-liveness signals.
  const { loopBodies } = recursionSignals(snap.invocations);
  const { liveBranchScopes } = branchLiveness(snap.invocations);

  // The region walk.
  const knotArm: { knot: number; arm: number }[] = [];
  const knotInputs: { knot: number; from: number }[] = [];
  const ctx: RegionWalkCtx = {
    loopBodies,
    liveBranchScopes,
    pointIds,
    valueById,
    liveValueById,
    fieldPointMeta: snap.fieldPointMeta,
    originCache,
    knotArm,
    knotInputs,
  };
  const tops = snap.invocations.filter((i) => !i.parent);
  const roots = tops.flatMap((t) => regionsAt(t, ctx));

  // Field attribution rewrites the base edges in place.
  const finalizeCtx: FinalizeCtx = { points, pointIds, reach, fieldPointMeta: snap.fieldPointMeta, originCache };
  const attributed = attributeFieldEdges(edges, finalizeCtx);
  edges.length = 0;
  edges.push(...attributed);

  // Decision wires, then the statement-output terminal.
  appendDecisionEdges(edges, knotArm, knotInputs);
  appendOutput(roots, edges, tops[tops.length - 1], finalizeCtx);

  // Stage 2a — container boundary ports.
  derivePorts(roots, edges);

  return { roots, edges, warnings: [] };
}

export function traceToRegions(trace: EvalTrace): RegionGraph {
  return buildRegions(snapshotTrace(trace), trace);
}
