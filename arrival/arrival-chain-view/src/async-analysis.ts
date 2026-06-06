/**
 * Async taint analysis for the run-view. A `.prompt` call is an async LLM call
 * (ax `forward` returns a Promise), so any function that transitively reaches one
 * must be `async`. This computes that set over the define graph.
 *
 * The analysis is a SAFE over-approximation: a higher-order function that calls a
 * function-valued parameter is marked async even if it's only ever passed sync
 * functions. That's harmless — `await` on a non-Promise is a no-op in JS — and it
 * keeps the analysis a simple fixpoint instead of a whole-program flow solve.
 */
import { cleanName } from "./names.js";
import { type Atom, head, isAtom, isList, type Node } from "./nodes.js";

/** Scheme builtins whose FIRST argument is a function that gets invoked (so an async
 *  function passed there taints the caller). */
const HIGHER_ORDER = new Set([
  "map",
  "filter",
  "every",
  "some",
  "for-each",
  "reduce",
  "fold-left",
  "fold-right",
  "max-by",
  "min-by",
  "sort-by",
  "apply",
]);

/** Local names bound to a `.prompt` require — the async inference primitives. */
export function inferPrimitives(forest: Node[]): Set<string> {
  const out = new Set<string>();
  for (const form of forest) {
    if (isList(form) && head(form) === "define" && isAtom(form.list[1])) {
      const rhs = form.list[2];
      if (isList(rhs) && head(rhs) === "require") {
        const p = rhs.list[1];
        if (isAtom(p) && p.str && p.atom.endsWith(".prompt")) out.add(cleanName(form.list[1].atom));
      }
    }
  }
  return out;
}

/** cleanNames bound by a param list `(a b . rest)` (the `.` separator dropped). */
function paramNames(list: Node | undefined): string[] {
  return isList(list)
    ? list.list.filter((p): p is Atom => isAtom(p) && p.atom !== ".").map((p) => cleanName(p.atom))
    : [];
}

/** cleanNames bound by let-bindings `((x i) (y j))` (or a sloppy `(x y)`). */
function letVarNames(bindings: Node | undefined): string[] {
  if (!isList(bindings)) return [];
  return bindings.list
    .map((b) => (isList(b) && isAtom(b.list[0]) ? cleanName(b.list[0].atom) : isAtom(b) ? cleanName(b.atom) : ""))
    .filter((s) => s.length > 0);
}

/**
 * Cleaned names of the functions that are async — they transitively call an inference
 * primitive, another async function, or a function-valued parameter. A SCOPE-AWARE fixpoint
 * over EVERY function: top-level `define`, internal (body-local) `define`, value-define bound
 * to a `lambda`, and named-`let` loop. Each function's param set is its OWN params PLUS every
 * ENCLOSING param — so an internal `(define (loop …) (… (f …)))` that calls an enclosing
 * fn-param `f` is correctly tainted (the conservative function-valued-param rule). Without the
 * enclosing params, internal helpers reaching infer would emit a sync arrow that then awaits.
 *
 * cleanName-keyed: two distinct bindings that clean to the same name share async state (a
 * harmless over-approximation — `await` on a non-Promise is a no-op; the namer disambiguates
 * the emitted names independently).
 */
export function computeAsyncNames(forest: Node[], inferReqs: Set<string>): Set<string> {
  const defs = new Map<string, { params: Set<string>; body: Node[] }>();

  const register = (name: string, params: Set<string>, body: Node[]): void => void defs.set(name, { params, body });

  const visit = (forms: Node[], enclosing: Set<string>): void => {
    for (const n of forms) visitForm(n, enclosing);
  };
  const visitForm = (n: Node, enclosing: Set<string>): void => {
    if (!isList(n) || n.list.length === 0) return;
    const h = head(n);
    if (h === "define") {
      const sig = n.list[1];
      if (isList(sig) && isAtom(sig.list[0])) {
        const params = new Set([...enclosing, ...paramNames({ list: sig.list.slice(1) })]);
        register(cleanName(sig.list[0].atom), params, n.list.slice(2));
        visit(n.list.slice(2), params);
      } else if (isAtom(sig)) {
        const val = n.list[2];
        if (isList(val) && head(val) === "lambda") {
          const params = new Set([...enclosing, ...paramNames(val.list[1])]); // (define f (lambda (g) …))
          register(cleanName(sig.atom), params, val.list.slice(2));
          visit(val.list.slice(2), params);
        } else {
          register(cleanName(sig.atom), new Set(enclosing), val ? [val] : []);
          if (val) visitForm(val, enclosing);
        }
      }
      return;
    }
    if (h === "lambda") return void visit(n.list.slice(2), new Set([...enclosing, ...paramNames(n.list[1])]));
    if (h === "let" || h === "let*") {
      const named = isAtom(n.list[1]);
      const bindings = named ? n.list[2] : n.list[1];
      const body = n.list.slice(named ? 3 : 2);
      const inner = new Set([...enclosing, ...letVarNames(bindings)]);
      if (named) {
        inner.add(cleanName((n.list[1] as Atom).atom));
        register(cleanName((n.list[1] as Atom).atom), inner, body); // the loop is a function
      }
      if (isList(bindings)) for (const b of bindings.list) if (isList(b) && b.list[1]) visitForm(b.list[1], enclosing);
      visit(body, inner);
      return;
    }
    for (const c of n.list) visitForm(c, enclosing);
  };
  visit(forest, new Set());

  const asyncNames = new Set(inferReqs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, def] of defs) {
      if (asyncNames.has(name)) continue;
      if (callsAsync(def.body, def.params, asyncNames, inferReqs)) {
        asyncNames.add(name);
        changed = true;
      }
    }
  }
  return asyncNames;
}

/** Does a single node reach async — used to decide whether a lambda passed to a
 *  higher-order builtin must be `async`. */
export function reachesAsync(node: Node, asyncNames: Set<string>, inferReqs: Set<string>): boolean {
  return callsAsync([node], new Set(), asyncNames, inferReqs);
}

/** Does any call in `forms` (at any nesting) reach an async name — directly in head
 *  position, as the function argument to a higher-order builtin, or by invoking a
 *  function-valued parameter? */
function callsAsync(forms: Node[], params: Set<string>, asyncNames: Set<string>, inferReqs: Set<string>): boolean {
  const isAsync = (name: string): boolean => asyncNames.has(name) || inferReqs.has(name) || params.has(name);
  let found = false;
  const walk = (n: Node): void => {
    if (found || !isList(n)) return;
    const h = n.list[0];
    if (isAtom(h) && !h.str) {
      if (isAsync(cleanName(h.atom))) {
        found = true;
        return;
      }
      // Higher-order: the function argument (first operand) is invoked by the builtin.
      if (HIGHER_ORDER.has(h.atom)) {
        const fnArg = n.list[1];
        if (isAtom(fnArg) && !fnArg.str && isAsync(cleanName(fnArg.atom))) {
          found = true;
          return;
        }
      }
    }
    for (const c of n.list) walk(c);
  };
  for (const f of forms) walk(f);
  return found;
}
