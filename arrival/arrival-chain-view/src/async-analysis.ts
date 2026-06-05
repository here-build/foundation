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
import { head, isAtom, isList, type Node } from "./nodes.js";

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

/**
 * Cleaned names of the `define`d functions that are async — they transitively call
 * an inference primitive, another async function, or a function-valued parameter.
 * Fixpoint over the define graph.
 */
export function computeAsyncNames(forest: Node[], inferReqs: Set<string>): Set<string> {
  const defs = new Map<string, { params: Set<string>; body: Node[] }>();
  for (const form of forest) {
    if (!isList(form) || head(form) !== "define") continue;
    const sig = form.list[1];
    if (isList(sig) && isAtom(sig.list[0])) {
      const params = new Set(sig.list.slice(1).filter(isAtom).map((a) => cleanName((a as { atom: string }).atom)));
      defs.set(cleanName(sig.list[0].atom), { params, body: form.list.slice(2) });
    } else if (isAtom(sig)) {
      defs.set(cleanName(sig.atom), { params: new Set(), body: form.list.slice(2) });
    }
  }

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
