/**
 * trace → candidate-box forest: the bridge from a real EvalTrace to the
 * laminar forest the MDL collapse optimizer consumes (`mdl-collapse.ts`).
 *
 * The trace records EVERY Pair invocation, ~80% of which is stdlib plumbing
 * (`list`/`cons`/`apply`/`if`/`null?`/`car`/…, including a map's own internal
 * machinery). The forest must filter to MEANINGFUL scopes and re-parent their
 * children *through* the plumbing. Meaningful (the box vocabulary V chose,
 * scheme "A" + promotable defines):
 *   - provenance points (infer/query) — repeated `leaf` boxes
 *   - recognized control forms — map/filter/for-each (unfold), reduce/fold
 *     (fold), cond/case/when/unless (dnf)
 *   - self-recursion — the BODY of a self-recursive function (loop), ×K iters
 *   - promoted user `define`s — opted-in via `opts.promoted` (suggested/forced)
 * User function calls are otherwise TRANSPARENT (their children re-parent up).
 *
 * Multiplicity uses MEASURED occurrence counts, not per-level products: a box's
 * `n = occurrences / parent-occurrences`. This telescopes (ancestorMult·n =
 * measured occurrences) so conditionals (a node that ran 2 of 3 loop iters) and
 * self-recursion fall out correctly — no integer-multiplicity assumption. (The
 * ×N *display* badge should use measured occurrences; `n` here is the cost-math
 * ratio and may be fractional for conditional scopes.)
 *
 * Ids are STRUCTURAL (`head@line:col`) so the layout is stable across runs
 * (V's stability directive) — not derived from iteration order.
 *
 * v1 approximations (documented, not hidden):
 *   - `localBits` is a proxy (count of a representative instance's immediate
 *     plumbing children); `distinctShapes` defaults to 1 (structural shape-class
 *     detection across instances is the next step).
 *   - Loop bodies now nest correctly (the loop box is the recursive function's
 *     BODY scope — entered ×K, including the first call — so the per-iteration
 *     work nests under one box; see the loop-detection comment below). The prior
 *     gap (loop boxed at the call-site → first iteration's map orphaned at root)
 *     is fixed.
 *   - Accessor macros (`field`/`@`) expand to a `cond` the classifier currently
 *     sees as a dnf box (minor noise; refine by skipping macro-internal forms).
 */
import type { BoxType, CandidateBox } from "./mdl-collapse.js";
import { snapshotTrace, type PlainInv } from "./trace-snapshot.js";
import type { EvalTrace } from "./trace.js";

const CONTROL_TYPE: Record<string, BoxType> = {
  map: "unfold",
  filter: "unfold",
  "for-each": "unfold",
  reduce: "fold",
  fold: "fold",
  "fold-left": "fold",
  "fold-right": "fold",
  cond: "dnf",
  case: "dnf",
  when: "dnf",
  unless: "dnf",
};

/** Non-control special forms — binding/sequencing/branching machinery that is
 *  never a user box, and (crucially) must be excluded from loop detection: a
 *  recursive function's body re-enters its `let`/`if`/`begin` every iteration,
 *  so "any same-Pair ancestor" would mistake those for loops. A loop is a
 *  recursive APPLICATION, not a special form. (cond/case/when/unless are NOT
 *  here — they're dnf control forms.) */
const STRUCTURAL_FORMS = new Set([
  "let",
  "let*",
  "letrec",
  "if",
  "begin",
  "lambda",
  "define",
  "and",
  "or",
  "quote",
  "quasiquote",
  "set!",
]);

/** Leading symbol of a form's Pair, e.g. `(map …)` → `"map"`. */
function headOf(node: unknown): string {
  const car = (node as { car?: { __name__?: unknown } } | null)?.car;
  const name = (car as { __name__?: unknown } | undefined)?.__name__;
  return typeof name === "string" ? name : "?";
}

/** Stable structural scope id: `head@line:col` (or `head` if unlocated). The
 *  parser stamps a `__location__` symbol on located Pairs. Exported so the
 *  unified flow-graph builder can bridge causal-chart nodes (keyed by Pair
 *  identity) back to forest boxes (keyed by this id) — both group by the same
 *  Pair, so the strings coincide. */
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

export interface ForestOptions {
  /** User-define scopes promoted to boxes: head name → mode. "suggested" enters
   *  as a normal MDL candidate; "forced" pins it collapsed (force-override). */
  promoted?: Map<string, "suggested" | "forced">;
}

export function traceToForest(trace: EvalTrace, opts: ForestOptions = {}): CandidateBox[] {
  const promoted = opts.promoted ?? new Map<string, "suggested" | "forced">();

  // De-proxy the observable trace once; the classification passes below then walk
  // plain parent/children/node refs (no MobX per-read cost). Signature unchanged.
  const all: PlainInv[] = snapshotTrace(trace).invocations;

  // A loop = a self-recursive function. We box its BODY (the lambda-body scope,
  // entered once per iteration — INCLUDING the first, top-level call), NOT the
  // recursive call-site. The body Pair telescopes all K iterations into one ×K
  // box and the per-iteration work (map / infer / …) nests under it; the
  // call-site fires only K−1 times and orphans the first iteration's body at root
  // (the old behaviour — see the trace: `loop`-call ⊃ `let`-body ⊃ {work, `if` ⊃
  // recursive `loop`-call ⊃ `let`-body ⊃ …}).
  //
  // Two steps:
  //  1. recursive functions — a (non-structural) APPLICATION whose Pair recurs on
  //     its own ancestor chain; its head names the recursive function.
  //  2. loop bodies — a re-entrant scope whose PARENT is a recursive-function
  //     application (the form that function evaluates each call). The first,
  //     top-level body entry isn't itself re-entrant but shares the body Pair, so
  //     it joins the same box via grouping. Works for tail- AND stack-recursion
  //     (the body Pair is entered K times either way; multiplicity collapses it).
  const hasSelfAncestor = (inv: PlainInv): boolean => {
    for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
    return false;
  };
  const recursiveFnHeads = new Set<string>();
  for (const inv of all) {
    if (STRUCTURAL_FORMS.has(headOf(inv.node))) continue;
    if (hasSelfAncestor(inv)) recursiveFnHeads.add(headOf(inv.node));
  }
  const loopScopes = new Set<object>();
  for (const inv of all) {
    if (inv.parent && hasSelfAncestor(inv) && recursiveFnHeads.has(headOf(inv.parent.node))) {
      loopScopes.add(inv.node as object);
    }
  }

  const meaningful = (inv: PlainInv): boolean =>
    inv.isProvenancePoint ||
    headOf(inv.node) in CONTROL_TYPE ||
    promoted.has(headOf(inv.node)) ||
    loopScopes.has(inv.node as object);

  // Box-parent: nearest ancestor that is meaningful AND a DIFFERENT scope —
  // skipping same-scope ancestors collapses self-recursion into one loop box.
  const boxParent = (inv: PlainInv): object | null => {
    for (let p = inv.parent; p; p = p.parent) {
      if (meaningful(p) && p.node !== inv.node) return p.node as object;
    }
    return null;
  };

  // Group meaningful invocations by scope (Pair identity).
  const groups = new Map<object, PlainInv[]>();
  for (const inv of all) {
    if (!meaningful(inv)) continue;
    const g = groups.get(inv.node as object);
    if (g) g.push(inv);
    else groups.set(inv.node as object, [inv]);
  }

  const occ = (scope: object): number => groups.get(scope)?.length ?? 0;
  const parentOf = new Map<object, object | null>();
  for (const [scope, invs] of groups) parentOf.set(scope, boxParent(invs[0]!));

  // Build a box per scope.
  const boxes = new Map<object, CandidateBox>();
  for (const [scope, invs] of groups) {
    const rep = invs[0]!;
    const head = headOf(scope);
    const type: BoxType = loopScopes.has(scope) ? "loop" : (CONTROL_TYPE[head] ?? "leaf");
    const mode = promoted.get(head);
    boxes.set(scope, {
      id: scopeId(scope),
      type,
      n: 1, // filled below once parent occurrences are known
      localBits: 1 + rep.children.filter((c) => !meaningful(c)).length,
      distinctShapes: 1,
      ...(mode === "forced" ? { force: "collapsed" as const } : {}),
      children: [],
    });
  }

  // Wire nesting and multiplicity (n = occurrences / parent-occurrences).
  const roots: CandidateBox[] = [];
  for (const [scope, box] of boxes) {
    const ps = parentOf.get(scope) ?? null;
    const parentOcc = ps ? occ(ps) : 1;
    box.n = occ(scope) / (parentOcc || 1);
    const parentBox = ps ? boxes.get(ps) : undefined;
    if (parentBox) parentBox.children.push(box);
    else roots.push(box);
  }
  return roots;
}
