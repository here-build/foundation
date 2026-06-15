/**
 * AST shape detection — classify a parsed scheme Pair into a semantic
 * shape so the trace UI can collapse syntactically-flat invocations into
 * meaningful containers. The cohort can't do this — they don't own the
 * AST; arrival does, and the homoiconic substrate makes it cheap.
 *
 * Detection is shallow + pattern-match — `(map f xs)` is recognised by
 * the head symbol being `map` and arity matching. No type analysis, no
 * macro expansion. Misses are returned as `{kind: "atomic"}` and render
 * raw. The point is to catch the high-frequency shapes (HOFs, loops,
 * branches) that explode into 200+ invocation nodes today.
 *
 * Pair / Symbol are duck-typed for the same reason as extract-defines:
 * the concrete classes are vendored deep in arrival-scheme — NO direct
 * dep on internals.
 */

const isPair = (v: unknown): v is { car: unknown; cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

const isSymbol = (v: unknown): v is { __name__: string | symbol } =>
  v !== null && typeof v === "object" && "__name__" in v;

const symName = (s: { __name__: string | symbol }): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** Collect a proper-list Pair chain to a JS array. Non-pair tails are dropped. */
function toArray(p: unknown): unknown[] {
  const out: unknown[] = [];
  let cur = p;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** Head symbol of a call form, or null if not a call. */
function headSymbolOf(form: unknown): string | null {
  if (!isPair(form)) return null;
  const head = form.car;
  if (!isSymbol(head)) return null;
  return symName(head);
}

/**
 * Higher-order functions that produce one invocation of `fn` per element.
 * Detection: head symbol + arity. The list-binding semantics differ slightly
 * (map vs for-each vs filter return shape) but the collapse-shape is the
 * same: render one container with N parallel iterations.
 */
const PAR_HOFS = new Set(["map", "for-each", "filter", "filter-map", "find", "count-if", "some", "every"]);

/**
 * Higher-order functions that fold a list into one value, sequentially
 * passing the accumulator. Collapse-shape: container with stepwise
 * accumulator evolution, not parallel iterations.
 */
const FOLD_HOFS = new Set(["reduce", "fold", "fold-left", "fold-right", "foldl", "foldr"]);

const COND_HEADS = new Set(["if", "cond", "when", "unless", "case"]);

export type Shape =
  | { kind: "map"; head: string; fnArg?: unknown; listArg?: unknown }
  | { kind: "fold"; head: string; fnArg?: unknown; initArg?: unknown; listArg?: unknown }
  | { kind: "branch"; head: string; cond?: unknown; arms: unknown[] }
  | { kind: "loop-named-let"; loopName: string; bindings: unknown[]; body: unknown[] }
  | { kind: "tail-recursive"; defineName: string }
  | { kind: "sequence"; head: string; forms: unknown[] }
  | { kind: "infer"; model?: unknown; prompt?: unknown }
  | { kind: "define"; name?: string; body: unknown[] }
  | { kind: "atomic" };

/**
 * Classify a form into a structural shape. Shallow — does not recurse;
 * caller picks how deep to walk. Returns `{kind: "atomic"}` if the form
 * doesn't match any known shape.
 */
export function detectShape(form: unknown): Shape {
  const head = headSymbolOf(form);
  if (!head) return { kind: "atomic" };
  if (!isPair(form)) return { kind: "atomic" };

  const args = toArray(form.cdr);

  if (PAR_HOFS.has(head)) {
    return { kind: "map", head, fnArg: args[0], listArg: args[1] };
  }
  if (FOLD_HOFS.has(head)) {
    // reduce/fold-left: (reduce f init xs). fold-right: same shape. Some
    // dialects flip init/list order; the last arg is ALWAYS taken as the
    // list and the middle as init, which fits the bulk of the cohort.
    const last = args.at(-1);
    const init = args.length >= 3 ? args.at(-2) : undefined;
    return { kind: "fold", head, fnArg: args[0], initArg: init, listArg: last };
  }
  if (COND_HEADS.has(head)) {
    return { kind: "branch", head, cond: args[0], arms: args.slice(1) };
  }
  if (head === "begin" || head === "and" || head === "or") {
    return { kind: "sequence", head, forms: args };
  }
  if (head === "infer" || head === "infer/chat") {
    return { kind: "infer", model: args[0], prompt: args[1] };
  }
  // Named-let loop: `(let loop-name ((b1 v1) (b2 v2)) body...)`
  if (head === "let" && args.length >= 2 && isSymbol(args[0])) {
    return {
      kind: "loop-named-let",
      loopName: symName(args[0] as { __name__: string | symbol }),
      bindings: toArray(args[1]),
      body: args.slice(2),
    };
  }
  if (head === "define") {
    // `(define (name . args) body...)` or `(define name expr)`
    if (isPair(args[0]) && isSymbol(args[0].car)) {
      const name = symName(args[0].car);
      return { kind: "define", name, body: args.slice(1) };
    }
    if (isSymbol(args[0])) {
      return { kind: "define", name: symName(args[0]), body: args.slice(1) };
    }
    return { kind: "define", body: args.slice(1) };
  }

  return { kind: "atomic" };
}

/**
 * Walk a define body and decide whether the recursion is in tail
 * position — i.e. the recursive call is the LAST expression in the
 * body or in the tail arm of every branch.
 *
 * Approximation: if the define name appears as the head symbol of a
 * form in tail position of the body, it's tail-recursive. Misses
 * trampolined / mutually-recursive cases; catches the common
 * `(define (loop n) ... (loop (- n 1)))` shape.
 */
export function isTailRecursive(defineName: string, body: readonly unknown[]): boolean {
  if (body.length === 0) return false;
  return isTailCallOf(defineName, body.at(-1));
}

function isTailCallOf(name: string, form: unknown): boolean {
  const head = headSymbolOf(form);
  if (head === name) return true;
  // Tail-position descent for control forms.
  if (head === "if") {
    const args = isPair(form) ? toArray(form.cdr) : [];
    // (if cond then else?) — both arms are tail positions.
    return (
      (args[1] !== undefined && isTailCallOf(name, args[1])) || (args[2] !== undefined && isTailCallOf(name, args[2]))
    );
  }
  if (head === "cond") {
    const args = isPair(form) ? toArray(form.cdr) : [];
    for (const clause of args) {
      // Each clause: (cond-expr body...) ; tail is the last body form.
      if (isPair(clause)) {
        const parts = toArray(clause.cdr);
        if (parts.length > 0 && isTailCallOf(name, parts.at(-1))) return true;
      }
    }
    return false;
  }
  if (head === "begin" || head === "let" || head === "let*" || head === "letrec") {
    const args = isPair(form) ? toArray(form.cdr) : [];
    const last = args.at(-1);
    return last !== undefined && isTailCallOf(name, last);
  }
  return false;
}
