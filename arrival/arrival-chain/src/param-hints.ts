import { readSweet } from "./sweet-read.js";
import { type Node, parseSexprs } from "./sweet-render.js";

/**
 * Parameter-name inlay hints. For a call to a `(define (f a b c) …)`, place a hint
 * before each positional arg naming its formal — the IDE inlay-hint idea, applied
 * to scheme. It's intent-over-materialization for code: a positional call hides the
 * parameter names; the hint restores them as transparent glass, never written into
 * the source.
 *
 * Pure function of the text → `{pos, name}[]`, where `pos` is the arg's start offset
 * (the hint renders just before it). Lens-agnostic in spirit; this entry parses
 * CLASSIC scheme (`parseSexprs`). The sweet lens reuses the same resolver over a
 * span-bearing sweet parse — a follow-up. Returns `[]` on a parse error so a
 * mid-edit buffer shows no hints rather than throwing.
 *
 * v1 scope (deliberate): user `define`d functions only — no builtins (no formals to
 * read) — and a FLAT name→formals map, so lexical shadowing of a same-named binding
 * isn't yet resolved. Both are the "declared statically via define" subset.
 */

export interface ParamHint {
  /** Char offset of the arg this hint labels; the widget renders immediately before it. */
  pos: number;
  /** The formal parameter's name. */
  name: string;
}

type Atom = { atom: string; str?: boolean; span?: readonly [number, number] };
type List = { list: Node[]; span?: readonly [number, number] };
const isAtom = (n: Node | undefined): n is Atom => n != null && "atom" in n;
const isList = (n: Node | undefined): n is List => n != null && "list" in n;

/** Drop a dotted-rest tail: `(a b . rest)` tokenizes as `[a, b, ., rest]`; cut at the
 *  `.` so the rest param takes no positional hint (rest hinting is a follow-up). */
const positional = (names: string[]): string[] => {
  const dot = names.indexOf(".");
  return dot === -1 ? names : names.slice(0, dot);
};

/** A function-shaped define → its name + positional formals, else null:
 *    (define (f a b c) …)        → { name: "f", params: ["a","b","c"] }
 *    (define f (lambda (a b) …))  → { name: "f", params: ["a","b"] }  */
function defOf(nd: Node): { name: string; params: string[] } | null {
  if (!isList(nd) || nd.list.length < 2 || !isAtom(nd.list[0]) || nd.list[0].atom !== "define") return null;
  const sig = nd.list[1];
  if (isList(sig) && sig.list.length >= 1 && sig.list.every(isAtom)) {
    const names = (sig.list as Atom[]).map((a) => a.atom);
    return { name: names[0], params: positional(names.slice(1)) };
  }
  const val = nd.list[2];
  if (
    isAtom(sig) &&
    isList(val) &&
    isAtom(val.list[0]) &&
    val.list[0].atom === "lambda" &&
    isList(val.list[1]) &&
    val.list[1].list.every(isAtom)
  ) {
    return { name: sig.atom, params: positional((val.list[1].list as Atom[]).map((a) => a.atom)) };
  }
  return null;
}

/** A `:keyword` arg means the call is self-labeling (a kwarg call) — skip hints. */
const hasKwarg = (args: Node[]): boolean => args.some((a) => isAtom(a) && a.atom.startsWith(":"));

/** Classic lens: hints over the classic `.scm` parse. */
export function paramHints(src: string): ParamHint[] {
  try {
    return hintsFromForms(parseSexprs(src));
  } catch {
    return []; // mid-edit / malformed → no hints
  }
}

/** Sweet lens: the SAME resolver over a span-bearing sweet parse. The sweet text's
 *  spans are in sweet-text coordinates (what the sweet editor buffer shows). */
export function paramHintsSweet(src: string): ParamHint[] {
  try {
    return hintsFromForms(readSweet(src));
  } catch {
    return [];
  }
}

/** The lens-agnostic core: walk a span-bearing `Node` forest, hint every positional
 *  arg of a call to a function-define found in the same forest. */
function hintsFromForms(forms: Node[]): ParamHint[] {
  // 1. Collect function-defines anywhere in the tree → name → formals.
  const defs = new Map<string, string[]>();
  const scan = (nd: Node): void => {
    if (!isList(nd)) return;
    const d = defOf(nd);
    if (d) defs.set(d.name, d.params);
    for (const c of nd.list) scan(c);
  };
  for (const f of forms) scan(f);
  if (defs.size === 0) return [];

  // 2. Walk; emit a hint before each positional arg of a call to a known define.
  //    A define/lambda's formals list is a BINDING site, not a call — skip it.
  const hints: ParamHint[] = [];
  const walk = (nd: Node): void => {
    if (!isList(nd) || nd.list.length === 0) return;
    const head = nd.list[0];
    if (isAtom(head) && (head.atom === "define" || head.atom === "lambda" || head.atom === "define-macro")) {
      for (let k = 2; k < nd.list.length; k++) walk(nd.list[k]); // body only; skip the formals
      return;
    }
    if (isAtom(head) && defs.has(head.atom)) {
      const params = defs.get(head.atom)!;
      const args = nd.list.slice(1);
      if (!hasKwarg(args)) {
        for (let a = 0; a < args.length && a < params.length; a++) {
          const span = args[a].span;
          if (span) hints.push({ pos: span[0], name: params[a] });
        }
      }
    }
    for (const c of nd.list) walk(c);
  };
  for (const f of forms) walk(f);
  return hints;
}
