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
 *   - self-recursion — a scope whose invocation has a same-scope ancestor (loop)
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
 *   - KNOWN GAP — tail-recursive loop body does not nest under the loop box.
 *     The loop anchors to the recursive call-site (fires K−1 back-edges, not K
 *     iterations); under TCO the iteration body (e.g. the map) is parented
 *     outside that Pair, so it floats to root as a SIBLING of the loop instead
 *     of nesting under it. The box TYPES, fan-out multiplicities, leaf
 *     extraction, promotion and end-to-end collapse are all correct; only
 *     loop-body containment is wrong. Fix (next design pass): anchor the loop to
 *     the recursive function's body scope and nest its iterations. Pinned in
 *     trace-to-forest.test.ts ("KNOWN v1 GAP").
 *   - Accessor macros (`field`/`@`) expand to a `cond` the classifier currently
 *     sees as a dnf box (minor noise; refine by skipping macro-internal forms).
 */
import type { BoxType, CandidateBox } from "./mdl-collapse.js";
import type { EvalTrace, Invocation } from "./trace.js";

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

  const all: Invocation[] = [];
  for (const rec of trace.records.values()) for (const inv of rec.bindings) all.push(inv);

  // Loop scopes: a recursive APPLICATION (a scope with a same-Pair ancestor),
  // excluding structural special-forms (whose re-entry is the recursion's body,
  // not the loop itself — see STRUCTURAL_FORMS).
  const loopScopes = new Set<object>();
  for (const inv of all) {
    if (STRUCTURAL_FORMS.has(headOf(inv.node))) continue;
    for (let p = inv.parent; p; p = p.parent) {
      if (p.node === inv.node) {
        loopScopes.add(inv.node as object);
        break;
      }
    }
  }

  const meaningful = (inv: Invocation): boolean =>
    inv.isProvenancePoint ||
    headOf(inv.node) in CONTROL_TYPE ||
    promoted.has(headOf(inv.node)) ||
    loopScopes.has(inv.node as object);

  // Box-parent: nearest ancestor that is meaningful AND a DIFFERENT scope —
  // skipping same-scope ancestors collapses self-recursion into one loop box.
  const boxParent = (inv: Invocation): object | null => {
    for (let p = inv.parent; p; p = p.parent) {
      if (meaningful(p) && p.node !== inv.node) return p.node as object;
    }
    return null;
  };

  // Group meaningful invocations by scope (Pair identity).
  const groups = new Map<object, Invocation[]>();
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
