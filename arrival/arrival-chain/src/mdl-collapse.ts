/**
 * MDL collapse optimizer — decides which AST-licensed boxes to fold in the
 * causal graph, by minimizing a Minimum-Description-Length cost.
 *
 * This is the anti-spaghetti core (design doc:
 * docs/working-proposals/todo/host-studio-causal-graph-home.md §4). The
 * `statechart.ts` ×N collapse is the degenerate fixed-λ, AST-identity case of
 * this; this generalizes it to the MDL-optimal grouping.
 *
 * ── Why this is tractable (and SUBDUE/VoG are not) ───────────────────────────
 * SUBDUE/VoG are NP-hard because they SEARCH for repeated substructure
 * (subgraph isomorphism). We don't search: the AST hands us the candidate boxes
 * (every map/reduce/fold = unfold/fold, every cond/case/variant = dnf, every
 * named-let/self-recursion = loop), and those scopes NEST → a laminar family =
 * a containment forest. Optimal selection over a laminar family with an
 * ADDITIVE objective is a bottom-up tree DP, linear in the forest. We use VoG's
 * additive L(M)+L(E) form, NOT SUBDUE's ratio DL(G)/(DL(S)+DL(G|S)) — the ratio
 * does not decompose over independent subtrees and would silently break the DP
 * (the single most likely implementation bug; see design doc §4.2).
 *
 * ── Scope of THIS module (honest) ────────────────────────────────────────────
 * This is the DECISION ENGINE: candidate forest + cost params → optimal
 * collapse/expand per box, via the tree DP, using the REAL MDL membership term
 * (§4.3) so the "expose a lone node unless boxing pays" behavior is derived not
 * tuned. It deliberately uses a SIMPLIFIED additive cost model (per-box body
 * bits + membership + binding residual), NOT the bit-exact prefix-coded L(M)+
 * L(E) over the literal adjacency. That bit-exact accounting (prefix codes,
 * E⁺/E⁻ error matrices, type-label streams) is the productionization step; the
 * simplified model is faithful enough to prove the decision STRUCTURE behaves
 * (collapse flips correctly on multiplicity, on the zoom knob λ, and on
 * per-instance binding variance; nesting composes bottom-up). See
 * mdl-collapse.test.ts for the behavioral proof against a gepa-shaped forest.
 */

export type BoxType = "unfold" | "loop" | "dnf" | "fold";

export interface CandidateBox {
  id: string;
  type: BoxType;
  /** Multiplicity: iterations (loop), fan-out width (unfold), #arms (dnf). */
  n: number;
  /** Description bits of this box's OWN body structure, excluding children
   *  (one instance). Children are costed via the DP, not folded in here. */
  localBits: number;
  /** Per-instance binding variance: bits by which the n instances DIFFER from
   *  the template. 0 ⇒ identical instances (collapse is nearly free); high ⇒
   *  data-dependent rewiring, so a ×N box loses to inlining (design doc §4.7 —
   *  "charge the binding residual honestly"). */
  perInstanceResidualBits: number;
  children: CandidateBox[];
}

export interface CollapseParams {
  /** λ — weight on box-declaration overhead (universalInt(n) + type label).
   *  The zoom knob. LOW λ ⇒ cheap boxes ⇒ MORE collapse ⇒ fewer visible nodes
   *  (zoomed OUT, summarized); HIGH λ ⇒ expensive boxes ⇒ less collapse ⇒
   *  instances inlined (zoomed IN, detail). (Note: this is the opposite
   *  direction from an early design-doc draft — implementing it fixed the sign.
   *  #collapsed is monotone non-increasing in λ — see the test.) Lagrangian
   *  dual of a hard box-limit K. Default 1. */
  lambda?: number;
  /** ε — V's per-in-box parsimony tax: a collapsed box's body costs ×(1+ε), so
   *  a lone call stays OUTSIDE a box unless boxing genuinely pays. This is the
   *  RIGHT shape for AST-licensed boxes (membership is free — the scope names
   *  its members), NOT the VoG combinatorial term log2(C(n,m)) (which applies
   *  only when boxes are DISCOVERED over arbitrary subsets and would over-
   *  suppress small-but-wanted boxes like a ×3 fan-out). Default 0.01. */
  epsilon?: number;
}

export type Decision = "collapsed" | "expanded";

export interface CollapseResult {
  /** Decision per box id. */
  decisions: Map<string, Decision>;
  /** Total description length (bits) of the optimal grouping. */
  totalBits: number;
}

/** log2(k) with a floor so log2(0)=log2(1)=0 stays finite. */
const log2 = (k: number): number => (k <= 1 ? 0 : Math.log2(k));

/**
 * Rissanen universal code length for a non-negative integer (bits) — the cost
 * to write down "this box has n instances". `log2(n) + log2 2.865` is the
 * standard one-term approximation (the full log* iterates the log; one term is
 * plenty at our scales). This (× λ) is the box-declaration overhead — and
 * because n=1 ⇒ log2(1)=0, it already discourages boxing a single iteration.
 */
const universalIntBits = (n: number): number => log2(n) + 1.5165;

/**
 * Bottom-up tree DP over the laminar candidate forest. For each box, choose the
 * cheaper of:
 *   COLLAPSED — declare the box once: overhead (λ·[universalInt(n) + type label]
 *               + membership) + ONE template body (children at their optimal
 *               cost) + the n instances' binding residual.
 *   EXPANDED  — inline all n instances: n × (template body, children optimal).
 * The min is the subtree's optimal description length; the decision is recorded.
 * Children are resolved first (post-order), so `bodyBits` already reflects their
 * optimal grouping — this is what makes nesting (×3 fan-out inside ×K loop)
 * compose for free (design doc §4.6).
 *
 * Deterministic tie-break: COLLAPSED wins ties (then leave id order to the
 * caller's stable map) — equal-cost flips would cause visual churn across runs
 * (design doc §4.7), same discipline as canonical-DNF variant ordering.
 */
function solve(box: CandidateBox, params: Required<CollapseParams>, out: Map<string, Decision>): number {
  // Post-order: children first.
  let childrenBits = 0;
  for (const child of box.children) childrenBits += solve(child, params, out);

  // One instance of this box's body = its own structure + children's optimal cost.
  const bodyBits = box.localBits + childrenBits;

  const TYPE_LABEL_BITS = 2; // 4 box types → 2 bits to name which.
  const overhead = params.lambda * (universalIntBits(box.n) + TYPE_LABEL_BITS);

  // COLLAPSED: declare the box once (overhead) + ONE template body taxed by
  // (1+ε) (V's parsimony pressure) + the n instances' binding residual.
  const collapsed = overhead + bodyBits * (1 + params.epsilon) + box.n * box.perInstanceResidualBits;
  // EXPANDED: inline all n instances of the body.
  const expanded = box.n * bodyBits;

  // COLLAPSED wins ties (deterministic, bias toward the compressed view).
  if (collapsed <= expanded) {
    out.set(box.id, "collapsed");
    return collapsed;
  }
  out.set(box.id, "expanded");
  return expanded;
}

/**
 * Run the optimizer over a forest of top-level candidate boxes. Returns the
 * per-box collapse/expand decisions and the total optimal description length.
 */
export function collapseMDL(forest: CandidateBox[], params: CollapseParams = {}): CollapseResult {
  const resolved: Required<CollapseParams> = { lambda: params.lambda ?? 1, epsilon: params.epsilon ?? 0.01 };
  const decisions = new Map<string, Decision>();
  let totalBits = 0;
  for (const box of forest) totalBits += solve(box, resolved, decisions);
  return { decisions, totalBits };
}
