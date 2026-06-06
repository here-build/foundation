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
 * Currently expands: SRFI-26 `cut`; the threading family `->`/`~>` (thread-first),
 * `->>`/`~>>` (thread-last); and `compose`/`comp` (right-to-left) + `pipe`/`flow`
 * (left-to-right). Semantics match the arrival-scheme bootstrap macros EXACTLY — the view
 * must agree with execution. (`-->` method-chaining and `..` dot-access are JS-interop and
 * deliberately NOT expanded here yet — a separate concern.)
 */
import { type Atom, isAtom, isList, type ListNode, type Node } from "./nodes.js";

/** Expand every sugar form in a parse forest. Pure: returns a new forest, leaves input alone. */
export function desugar(forest: Node[]): Node[] {
  return forest.map(expand);
}

/** Bottom-up: expand children first (so a nested sugar form's own slots/threads are consumed
 *  by ITS expansion), then expand this node if it is itself a sugar form. `{ ...n, list }`
 *  PRESERVES every other property the parser attached (notably `span`, which the lowerer uses
 *  to place comments) — rebuilding as a bare `{ list }` would strip comments and positions. */
function expand(n: Node): Node {
  if (!isList(n)) return n;
  const list = n.list.map(expand);
  const h = isAtom(n.list[0]) && !n.list[0].str ? n.list[0].atom : undefined;
  switch (h) {
    case "cut":
      return { ...n, list: cutLambda(list) }; // keep the form's span on the synthetic node
    case "->":
    case "~>":
      return withSpan(n, thread(list[1], list.slice(2), "first"));
    case "->>":
    case "~>>":
      return withSpan(n, thread(list[1], list.slice(2), "last"));
    case "compose":
    case "comp":
      return { ...n, list: composeLambda(list.slice(1), "right-to-left") };
    case "pipe":
    case "flow":
      return { ...n, list: composeLambda(list.slice(1), "left-to-right") };
  }
  return { ...n, list };
}

/** Keep `n`'s span on a replacement node when the replacement is a list; pass atoms through. */
function withSpan(n: ListNode, replacement: Node): Node {
  return isList(replacement) ? { ...n, list: replacement.list } : replacement;
}

/**
 * Threading macros (Clojure/Racket positional — NOT a `_` placeholder). Thread `x` through
 * each step, inserting it as the FIRST arg (`->`/`~>`) or LAST arg (`->>`/`~>>`). A bare
 * symbol step `f` becomes `(f x)`; a call step `(f a b)` becomes `(f x a b)` / `(f a b x)`.
 * The result is an inline nested call — exactly what the bootstrap macro produces, so the
 * view matches execution.
 */
function thread(x: Node | undefined, forms: Node[], where: "first" | "last"): Node {
  if (x === undefined) return { list: [] };
  return forms.reduce<Node>((acc, form) => {
    if (!isList(form)) return { list: [form, acc] }; // bare `f` / `:kw` → (f acc)
    return where === "first"
      ? { list: [form.list[0]!, acc, ...form.list.slice(1)] } // (f a b) → (f acc a b)
      : { list: [...form.list, acc] }; // (f a b) → (f a b acc)
  }, x);
}

/**
 * `(compose f g h)` / `(pipe f g h)` → `(lambda (it) (f (g (h it))))` (compose, right-to-left)
 * or `(lambda (it) (h (g (f it))))` (pipe, left-to-right). Returns the lambda node's `.list`.
 * NESTING (rather than calling a runtime `compose`) keeps every function — including keyword
 * accessors — in head position, so `(compose :state last :versions)` lowers cleanly to
 * `(it) => last(it.versions).state` instead of erroring on a bare `:versions`. Faithful for
 * the unary pipelines `compose` is always used for here.
 */
function composeLambda(fns: Node[], dir: "right-to-left" | "left-to-right"): Node[] {
  const param: Atom = { atom: "it" };
  const ref: Atom = { atom: "it" };
  const wrap = (acc: Node, fn: Node): Node => ({ list: [fn, acc] });
  const body = dir === "left-to-right" ? fns.reduce(wrap, ref as Node) : fns.reduceRight(wrap, ref as Node);
  return [{ atom: "lambda" }, { list: [param] }, body];
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
