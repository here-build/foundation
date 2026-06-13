/**
 * Thin helpers over the arrival-chain `Node` parse forest. The projection lowers
 * this forest; everything here is pure shape inspection — no emit, no naming.
 */
import type { Node } from "@here.build/arrival-sweet";

export type { Node };

/** An atom node: a symbol, keyword, number, string (`str:true`), or `#t`/`#f`. */
export type Atom = { atom: string; str?: boolean; span?: readonly [number, number] };
/** A list node `(…)`. Quote/quasiquote desugar to `(quote x)` lists in the parser. */
export type ListNode = { list: Node[]; span?: readonly [number, number] };

export const isAtom = (n: Node | undefined): n is Atom => n != null && "atom" in n;
export const isList = (n: Node | undefined): n is ListNode => n != null && "list" in n;

/** Head symbol of a list form (the operator), or undefined for atoms / `()` / non-symbol heads. */
export const head = (n: Node | undefined): string | undefined =>
  isList(n) && isAtom(n.list[0]) ? n.list[0].atom : undefined;

/** A `:keyword` atom (the marker for a named argument). Not the bare `:`. */
export const isKeyword = (n: Node | undefined): n is Atom =>
  isAtom(n) && !n.str && n.atom.length > 1 && n.atom.startsWith(":");

/** `:input` → `input`. */
export const keywordName = (a: Atom): string => a.atom.slice(1);

/** A numeric literal atom (int / float / signed / exponent). A symbol is not a number. */
export const isNumber = (a: Atom): boolean => !a.str && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(a.atom);

export const isBool = (a: Atom): boolean => !a.str && (a.atom === "#t" || a.atom === "#f");

/** The empty list `()` / `'()`. */
export const isNil = (n: Node | undefined): boolean => isList(n) && n.list.length === 0;
