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
import { head, isAtom, isList, isKeyword, keywordName, type ListNode, type Node } from "./nodes.js";

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

/** Lower a node sitting in a SPREAD position (inside an array being built). A `(list a b)`
 *  literal splices its elements inline (`a, b`) rather than the machine-tell `...[a, b]`;
 *  an empty `(list)` contributes nothing; anything else is spread (`...x`). Shared by
 *  `cons` (its tail) and `append` (every arg) — splicing a literal into a spread is one idea. */
const spread = (a: Node, E: Emit): string => {
  const h = isList(a) ? a.list[0] : undefined;
  if (isList(a) && isAtom(h) && !h.str && h.atom === "list") {
    return a.list.slice(1).map((el) => E.lower(el)).join(", ");
  }
  return `...${E.lower(a)}`;
};

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
  cons: (a, b) => `[${a}, ...${b}]`, // prepend (the canonical cons; pairs use `list`)
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
  cdr: (a) => `${a}.slice(1)`, // list TAIL (cadr accesses the 2nd element of a pair)
  cadr: (a) => `${a}[1]`,
  caddr: (a) => `${a}[2]`,
  first: (a) => `${a}[0]`,
  "zero?": (a) => `${a} === 0`,
  "even?": (a) => `${a} % 2 === 0`,
  "odd?": (a) => `${a} % 2 !== 0`,
  not: (a) => `!${a}`,
  "null?": (a) => `${a}.length === 0`,
  "empty?": (a) => `${a}.length === 0`,
  length: (a) => `${a}.length`,
};

/** Inline a lambda `(lambda (p…) body)` with its params bound to argStrs — no IIFE,
 *  no call. Generalizes `inlineUnaryLambda` to N params, so a multi-list map with a
 *  multi-param lambda `(map (lambda (s m) …) xs ys)` inlines instead of currying. */
function inlineLambda(lambda: ListNode, argStrs: string[], E: Emit): string {
  const params = lambda.list[1];
  const body = lambda.list[2];
  if (isList(params) && body) {
    const names = params.list.filter(isAtom);
    if (names.length === argStrs.length) {
      return E.lowerWith(Object.fromEntries(names.map((p, i) => [p.atom, argStrs[i]!])), body);
    }
  }
  return `${E.lower(lambda)}(${argStrs.join(", ")})`;
}

/** Apply a function node to already-lowered argument strings (op-as-argument case). */
function applyFn(fn: Node, argStrs: string[], E: Emit): string {
  if (isList(fn) && head(fn) === "lambda") return inlineLambda(fn, argStrs, E);
  if (isAtom(fn) && !fn.str) {
    if (fn.atom === "list") return `[${argStrs.join(", ")}]`; // n-ary; e.g. `(map list xs ys)` → pairs
    const b = BINOP[fn.atom];
    if (b && argStrs.length === 2) return b(argStrs[0]!, argStrs[1]!);
    const u = UNOP[fn.atom];
    if (u && argStrs.length === 1) return u(argStrs[0]!);
  }
  return `${E.lower(fn)}(${argStrs.join(", ")})`;
}

/** A function that can be passed by reference to a JS array method (a lambda, a `cut`,
 *  or a user fn — not a builtin op). `cut` lowers to a lambda, so it passes too. */
function passableFn(fn: Node): boolean {
  if (isList(fn) && (head(fn) === "lambda" || head(fn) === "cut")) return true;
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
  // `cons` is PREPEND — `(cons x xs)` → `[x, ...xs]` (the 99% Scheme use). A 2-tuple/pair
  // is `(list a b)`, accessed by `car`/`cadr`. So cons + car/cadr/cdr coexist cleanly.
  cons: (args, E) => {
    const tail = spread(args[1]!, E);
    return `[${E.lower(args[0]!)}${tail ? `, ${tail}` : ""}]`;
  },
  car: (args, E) => `${E.lower(args[0]!)}[0]`,
  // `cdr` is the list TAIL; `cadr`/`caddr` access the 2nd/3rd element (of a pair or
  // list). Keeping them distinct is what lets `cons`/pairs and list-recursion coexist.
  cdr: (args, E) => `${E.lower(args[0]!)}.slice(1)`,
  cadr: (args, E) => `${E.lower(args[0]!)}[1]`,
  caddr: (args, E) => `${E.lower(args[0]!)}[2]`,
  "list-ref": (args, E) => `${recv(E.lower(args[0]!))}[${E.lower(args[1]!)}]`,
  first: (args, E) => `${E.lower(args[0]!)}[0]`,
  length: (args, E) => `${E.lower(args[0]!)}.length`,
  reverse: (args, E) => `[...${E.lower(args[0]!)}].reverse()`,
  append: (args, E) => `[${args.map((a) => spread(a, E)).filter((s) => s !== "").join(", ")}]`,
  min: (args, E) => `Math.min(${args.map((a) => E.lower(a)).join(", ")})`,
  max: (args, E) => `Math.max(${args.map((a) => E.lower(a)).join(", ")})`,

  // folds
  apply: (args, E) => {
    const [fn, xs] = args;
    // (apply map list rows) — transpose: combine the rows column-wise. `list` as the
    // combiner zips each column into an array; the one apply-map shape with a JS form.
    if (isAtom(fn) && !fn.str && fn.atom === "map") {
      const combiner = args[1];
      if (isAtom(combiner) && !combiner.str && combiner.atom === "list" && args[2]) {
        const rows = recv(E.lower(args[2]));
        return `((rows) => rows[0].map((_, i) => rows.map((row) => row[i])))(${rows})`;
      }
      throw new Error("`apply map` is supported only as the transpose `(apply map list rows)`");
    }
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
        case "append":
          return `${x}.flat()`; // (apply append list-of-lists) → concat one level
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
  "even?": (args, E) => `(${E.lower(args[0]!)} % 2 === 0)`,
  "odd?": (args, E) => `(${E.lower(args[0]!)} % 2 !== 0)`,
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
