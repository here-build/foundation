/**
 * The stdlib map: scheme builtin → emitted JS. The naive pass emits the
 * dumb-correct native-JS form (no ramda); the fix pass may idiomatize later.
 *
 * The one tricky family lives here — the ARITY BRIDGE. Scheme has variadic /
 * multi-list builtins; JS has only unary-list methods. `(map f xs ys)` and
 * `(every >= xs ys)` lower to an INDEX-driven traverse (`xs.map((x,i)=>…ys[i]…)`),
 * which is more legible than an explicit `zip`; `(apply + xs)` folds to `reduce`.
 */
import { cleanName, destructureTuple, elementName } from "./names.js";
import { head, isAtom, isList, isKeyword, keywordName, type Node } from "./nodes.js";

/** What a stdlib emitter receives: a way to lower sub-expressions (+ a binding-substituting variant). */
export interface Emit {
  /** Lower an expression node to a JS expression string. */
  lower(n: Node): string;
  /** Lower `body` with scheme→js name overrides pushed (used to inline a unary lambda in place). */
  lowerWith(bindings: Record<string, string>, body: Node): string;
  /** "read" (sync, legible) or "run" (async, ax-wired). */
  target: "read" | "run";
  /** Is this function node async (an async-named fn, or a lambda that awaits)? Run-view only. */
  isAsyncFn(node: Node): boolean;
}

/** Parenthesize an `await …` expression before a member access: `(await x).map(…)`,
 *  not `await x.map(…)` (which would `.map` the Promise). A no-op in the read-view. */
const recv = (s: string): string => (/^await\b/.test(s) ? `(${s})` : s);

type Emitter = (args: Node[], E: Emit) => string;

// ── string-level operator forms (used when an op is an argument, e.g. to `map`) ──

const BINOP: Record<string, (a: string, b: string) => string> = {
  "+": (a, b) => `${a} + ${b}`,
  "-": (a, b) => `${a} - ${b}`,
  "*": (a, b) => `${a} * ${b}`,
  "/": (a, b) => `${a} / ${b}`,
  "=": (a, b) => `${a} === ${b}`,
  "<": (a, b) => `${a} < ${b}`,
  ">": (a, b) => `${a} > ${b}`,
  "<=": (a, b) => `${a} <= ${b}`,
  ">=": (a, b) => `${a} >= ${b}`,
  cons: (a, b) => `[${a}, ${b}]`,
  "eq?": (a, b) => `${a} === ${b}`,
  "eqv?": (a, b) => `${a} === ${b}`,
  "equal?": (a, b) => `${a} === ${b}`,
  "string=?": (a, b) => `${a} === ${b}`,
  "string-ci=?": (a, b) => `${a}.toLowerCase() === ${b}.toLowerCase()`,
  modulo: (a, b) => `${a} % ${b}`,
  remainder: (a, b) => `${a} % ${b}`,
  quotient: (a, b) => `Math.trunc(${a} / ${b})`,
};

const UNOP: Record<string, (a: string) => string> = {
  car: (a) => `${a}[0]`,
  cdr: (a) => `${a}[1]`,
  first: (a) => `${a}[0]`,
  "zero?": (a) => `${a} === 0`,
  not: (a) => `!${a}`,
  "null?": (a) => `${a}.length === 0`,
  "empty?": (a) => `${a}.length === 0`,
  length: (a) => `${a}.length`,
};

/** Apply a function node to already-lowered argument strings (op-as-argument case). */
function applyFn(fn: Node, argStrs: string[], E: Emit): string {
  if (isAtom(fn) && !fn.str) {
    const b = BINOP[fn.atom];
    if (b && argStrs.length === 2) return b(argStrs[0]!, argStrs[1]!);
    const u = UNOP[fn.atom];
    if (u && argStrs.length === 1) return u(argStrs[0]!);
  }
  return `${E.lower(fn)}(${argStrs.join(", ")})`;
}

/** A function that can be passed by reference to a JS array method (a lambda, or a user fn — not a builtin op). */
function passableFn(fn: Node): boolean {
  if (isList(fn) && head(fn) === "lambda") return true;
  if (isAtom(fn) && !fn.str && !(fn.atom in BINOP) && !(fn.atom in UNOP) && !(fn.atom in STDLIB)) return true;
  return false;
}

/** Inline a unary lambda `(lambda (p) body)` with its parameter bound to `argStr` — no IIFE. */
function inlineUnaryLambda(lambda: Node, argStr: string, E: Emit): string {
  if (isList(lambda) && head(lambda) === "lambda") {
    const params = lambda.list[1];
    if (isList(params) && params.list.length === 1 && isAtom(params.list[0]) && lambda.list[2]) {
      return E.lowerWith({ [params.list[0].atom]: argStr }, lambda.list[2]);
    }
  }
  return applyFn(lambda, [argStr], E);
}

/** A single-param arrow, array-destructuring the param when it's consumed only as a
 *  tuple: `(x) => x[0]` → `([head]) => head`. */
function arrow1(param: string, body: string): string {
  const d = destructureTuple(param, body);
  return d ? `(${d.pattern}) => ${d.body}` : `(${param}) => ${body}`;
}

/** `(map f xs)` → `xs.map(f)`; `(map f xs ys)` → index-driven; async maps → `await Promise.all(…)`. */
function mapLike(method: "map" | "filter" | "every" | "some"): Emitter {
  return (args, E) => {
    const [fn, ...lists] = args;
    if (!fn || lists.length === 0) return `[]`;
    const el = elementName(lists[0]!) ?? "__x"; // examples.map((example) => …)
    const list = recv(E.lower(lists[0]!));
    const run = E.target === "run";
    if (lists.length === 1) {
      if (passableFn(fn)) {
        if (run && E.isAsyncFn(fn)) {
          if (method !== "map") throw new Error(`run-view: async \`${method}\` is unsupported (only async map)`);
          return `await Promise.all(${list}.map(${E.lower(fn)}))`;
        }
        return `${list}.${method}(${E.lower(fn)})`;
      }
      return `${list}.${method}(${arrow1(el, applyFn(fn, [el], E))})`;
    }
    // Multi-list: drive off the first list, pull the rest by index (the arity bridge).
    const idx = el === "i" || el === "index" ? "idx" : "i";
    const rest = lists.slice(1).map((l) => `${recv(E.lower(l))}[${idx}]`);
    const body = applyFn(fn, [el, ...rest], E);
    const d = destructureTuple(el, body);
    const param = d ? d.pattern : el;
    const inner = d ? d.body : body;
    if (run && inner.includes("await")) {
      if (method !== "map") throw new Error(`run-view: async \`${method}\` is unsupported`);
      return `await Promise.all(${list}.map(async (${param}, ${idx}) => ${inner}))`;
    }
    return `${list}.${method}((${param}, ${idx}) => ${inner})`;
  };
}

function variadicInfix(op: string, identity?: string): Emitter {
  return (args, E) => {
    if (args.length === 0) return identity ?? "undefined";
    if (op === "-" && args.length === 1) return `-${E.lower(args[0]!)}`;
    return `(${args.map((a) => E.lower(a)).join(` ${op} `)})`;
  };
}

function chainCompare(op: string): Emitter {
  return (args, E) => {
    const xs = args.map((a) => E.lower(a));
    if (xs.length <= 2) return `(${xs[0]} ${op} ${xs[1]})`;
    const pairs: string[] = [];
    for (let i = 0; i + 1 < xs.length; i++) pairs.push(`${xs[i]} ${op} ${xs[i + 1]}`);
    return `(${pairs.join(" && ")})`;
  };
}

function variadicLogic(op: string): Emitter {
  return (args, E) => `(${args.map((a) => E.lower(a)).join(` ${op} `)})`;
}

export const STDLIB: Record<string, Emitter> = {
  // list traversal (single-list → method; multi-list → index bridge)
  map: mapLike("map"),
  filter: mapLike("filter"),
  every: mapLike("every"),
  some: mapLike("some"),

  // list construction / access
  list: (args, E) => `[${args.map((a) => E.lower(a)).join(", ")}]`,
  cons: (args, E) => `[${E.lower(args[0]!)}, ${E.lower(args[1]!)}]`,
  car: (args, E) => `${E.lower(args[0]!)}[0]`,
  cdr: (args, E) => `${E.lower(args[0]!)}[1]`,
  first: (args, E) => `${E.lower(args[0]!)}[0]`,
  length: (args, E) => `${E.lower(args[0]!)}.length`,
  reverse: (args, E) => `[...${E.lower(args[0]!)}].reverse()`,
  append: (args, E) => `[${args.map((a) => `...${E.lower(a)}`).join(", ")}]`,
  min: (args, E) => `Math.min(${args.map((a) => E.lower(a)).join(", ")})`,
  max: (args, E) => `Math.max(${args.map((a) => E.lower(a)).join(", ")})`,

  // folds
  apply: (args, E) => {
    const [fn, xs] = args;
    const x = recv(E.lower(xs!));
    const el = elementName(xs!) ?? "__b"; // (apply + scores) → scores.reduce((acc, score) => …)
    if (isAtom(fn) && !fn.str) {
      switch (fn.atom) {
        case "+":
          return `${x}.reduce((acc, ${el}) => acc + ${el}, 0)`;
        case "*":
          return `${x}.reduce((acc, ${el}) => acc * ${el}, 1)`;
        case "-":
          return `${x}.reduce((acc, ${el}) => acc - ${el})`;
        case "/":
          return `${x}.reduce((acc, ${el}) => acc / ${el})`;
        case "max":
          return `Math.max(...${x})`;
        case "min":
          return `Math.min(...${x})`;
      }
      // An operator with no n-ary JS form (`<`, `string-append`, …) cannot be spread-called
      // — that would emit a call to a garbage identifier. A door, not a silent miss.
      if (isBuiltin(fn.atom)) throw new Error(`\`apply\` of operator \`${fn.atom}\` is unsupported (no n-ary JS form)`);
    }
    return `${E.lower(fn!)}(...${x})`; // free function → spread
  },
  // NOTE: empty-list precondition — `reduce` with no seed throws on `[]`. Scheme's
  // `max-by` also errors on the empty list, so this is faithful, not a new bug.
  "max-by": (args, E) => {
    const [fn, xs] = args;
    const list = recv(E.lower(xs!));
    const el = elementName(xs!) ?? "__x";
    const key = (v: string) => (isList(fn) && head(fn) === "lambda" ? inlineUnaryLambda(fn!, v, E) : applyFn(fn!, [v], E));
    return `${list}.reduce((acc, ${el}) => (${key(el)} > ${key("acc")} ? ${el} : acc))`;
  },

  // arithmetic
  "+": variadicInfix("+", "0"),
  "-": variadicInfix("-"),
  "*": variadicInfix("*", "1"),
  "/": variadicInfix("/"),
  modulo: (args, E) => `(${E.lower(args[0]!)} % ${E.lower(args[1]!)})`,
  remainder: (args, E) => `(${E.lower(args[0]!)} % ${E.lower(args[1]!)})`,
  quotient: (args, E) => `Math.trunc(${E.lower(args[0]!)} / ${E.lower(args[1]!)})`,

  // comparison / equality
  "=": chainCompare("==="),
  "<": chainCompare("<"),
  ">": chainCompare(">"),
  "<=": chainCompare("<="),
  ">=": chainCompare(">="),
  "eq?": (args, E) => `${E.lower(args[0]!)} === ${E.lower(args[1]!)}`,
  "eqv?": (args, E) => `${E.lower(args[0]!)} === ${E.lower(args[1]!)}`,
  "equal?": (args, E) => `${E.lower(args[0]!)} === ${E.lower(args[1]!)}`,
  "string=?": (args, E) => `(${E.lower(args[0]!)} === ${E.lower(args[1]!)})`,
  "string-ci=?": (args, E) => `(${E.lower(args[0]!)}.toLowerCase() === ${E.lower(args[1]!)}.toLowerCase())`,
  "string-append": (args, E) => `(${args.map((a) => E.lower(a)).join(" + ")})`,

  // predicates / logic
  "zero?": (args, E) => `(${E.lower(args[0]!)} === 0)`,
  "null?": (args, E) => `(${E.lower(args[0]!)}.length === 0)`,
  "empty?": (args, E) => `(${E.lower(args[0]!)}.length === 0)`,
  not: (args, E) => `!(${E.lower(args[0]!)})`,
  and: variadicLogic("&&"),
  or: variadicLogic("||"),

  // record literal
  dict: (args, E) => {
    const parts: string[] = [];
    for (let i = 0; i + 1 < args.length; i += 2) {
      const k = args[i]!;
      // A keyword key → a valid JS identifier key (`:max-words` → `maxWords`),
      // consistent with how every other identifier is cleaned. A hyphen would be
      // an invalid object key otherwise.
      const key = isKeyword(k) ? cleanName(keywordName(k)) : E.lower(k);
      parts.push(`${key}: ${E.lower(args[i + 1]!)}`);
    }
    return `{ ${parts.join(", ")} }`;
  },
};

/** Is `name` a stdlib builtin (so it is emitted as an operator, never imported as a free identifier)? */
export const isBuiltin = (name: string): boolean => name in STDLIB || name in BINOP || name in UNOP;
