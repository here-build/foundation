/**
 * Macro-expansion pre-pass: rewrite the authoring-surface forms that are really sugar for
 * core forms (`lambda`, `let`, `if`, calls) BEFORE the namer, async-analysis, and lowering
 * run — so every later pass sees only the core language and handles these forms for free.
 *
 * Why a pre-pass instead of expanding at emit time: when `cut` is turned into a lambda only
 * inside the emitter, the async-analysis and `isAsyncFn` never see the lambda, so a
 * `(map (cut trace … <>) xs)` over an async `trace` is neither tainted async nor
 * `Promise.all`-wrapped — it silently emits `xs.map(async … )` returning an array of
 * Promises. Expanding `cut` here makes it an ordinary lambda everywhere, and the existing
 * lambda machinery (taint, `Promise.all`, naming) handles it with no special cases.
 *
 * Currently expands: SRFI-26 `cut`. (Threading macros `->`/`->>`/`~>` and `compose` belong
 * here next — see docs/working-proposals/arrival-chain-view-type-aware-projection-2026-06-06.md.)
 */
import { type Atom, isAtom, isList, type ListNode, type Node } from "./nodes.js";

/** Expand every sugar form in a parse forest. Pure: returns a new forest, leaves input alone. */
export function desugar(forest: Node[]): Node[] {
  return forest.map(expand);
}

/** Bottom-up: expand children first (so a nested `cut`'s own `<>` slots are consumed by ITS
 *  expansion), then expand this node if it is itself a sugar form. `{ ...n, list }` PRESERVES
 *  every other property the parser attached (notably `span`, which the lowerer uses to place
 *  comments) — rebuilding as a bare `{ list }` would strip comments and source positions. */
function expand(n: Node): Node {
  if (!isList(n)) return n;
  const list = n.list.map(expand);
  if (isAtom(n.list[0]) && !n.list[0].str && n.list[0].atom === "cut") {
    return { ...n, list: cutLambda(list) }; // keep the cut's span on the synthetic lambda
  }
  return { ...n, list };
}

/**
 * `(cut proc a <> b <>)` → `(lambda (a-slot b-slot) (proc a a-slot b b-slot))` — the `.list`
 * of a lambda node. One param per `<>` hole, filled left-to-right; non-slot items (already
 * expanded) pass through untouched. Slot naming matches the former emit-time lowerers exactly
 * (`it` for a single hole, then `a b c d e f`), so the projected output is byte-identical —
 * `cut` is just visible to the earlier passes now.
 */
function cutLambda(expandedCutList: Node[]): Node[] {
  const items = expandedCutList.slice(1);
  const isSlot = (x: Node): boolean => isAtom(x) && !x.str && x.atom === "<>";
  const names = items.filter(isSlot).length === 1 ? ["it"] : ["a", "b", "c", "d", "e", "f"];
  const slots: Atom[] = [];
  const fill = (x: Node): Node => {
    if (!isSlot(x)) return x;
    const g: Atom = { atom: names[slots.length] ?? `arg${slots.length + 1}` };
    slots.push(g);
    return g;
  };
  const call: ListNode = { list: items.map(fill) };
  return [{ atom: "lambda" }, { list: slots }, call];
}
