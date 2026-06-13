/**
 * Effect analysis — abstract interpretation over the scheme Pair AST that answers, WITHOUT
 * executing, "does running this penetrate the membrane?" (i.e. does it reach `infer`, `http`,
 * `sql`, or `mcp` — the `EffectKind`s of `effect-log.ts`, the run's entire contact with
 * non-determinism). The studio uses it to show `▶` only on cells that actually cost something.
 *
 * WHY NOT execute-and-break: a penetration can sit inside an un-entered branch or an unforced
 * lambda body — `(define (ask q) (infer q))` is PURE to evaluate (binding a lambda touches
 * nothing) and only penetrates when `ask` is CALLED. An execution probe either never fires it
 * (false "pure") or halts on the very `infer` it's trying to merely detect. Detection-by-running
 * is category-wrong; the cost lives in code that hasn't run. Static is the only sound reading.
 *
 * THE SHAPE (the homoiconic isomorphism): this is the SAME fold the kernel does to build a
 * VALUE-environment, run in the abstract domain {pure, latent} to build an EFFECT-environment.
 * `evalForm` shadows `eval`; a cell's exported defines thread into the next cell's env exactly
 * as the shared kernel threads bindings — which is what closes the cross-cell gap (cell N calls
 * an `infer`-ing helper `define`d in cell N-1) with no execution.
 *
 * THE DOMAIN:
 *   - `pure`   — evaluating it triggers nothing; if callable, calling it triggers nothing.
 *   - `latent` — a callable whose INVOCATION crosses the membrane (a penetrating builtin like
 *                `infer`, or a user lambda whose body would trigger). Referencing it is pure;
 *                CALLING it triggers.
 * `triggers` (the boolean we surface) = does evaluating a form in eval-order penetrate NOW.
 * Defining a latent lambda is pure-now + exports a latent binding; the penetration is at the
 * call site, which is where the button-worthiness lives.
 *
 * APPROXIMATION (monovariant, safe-direction): unknown symbols default `pure`; built-in HOFs
 * (`map`/`fold`/…) propagate their function arg's latency so `(map infer xs)` is caught, but a
 * USER-defined HOF receiving a penetrating fn as an argument is not (effect-polymorphism is out
 * of scope for v1 — noted, not silently dropped). Control forms over-approximate by OR-ing all
 * sub-form triggers, which can only ADD a button (run a pure cell, costs nothing), never hide
 * one — the safe direction.
 *
 * Pair / Symbol are duck-typed (same vendoring rationale as `ast-shapes.ts` / `slice.ts`): the
 * concrete classes live deep in arrival-scheme and we don't want a dep on internals. This module
 * is pure + synchronous + dependency-free, so it lifts cleanly to an arrival builtin later
 * (`(effects-of (quote …))`) if the compiler / runner / server want the same reading server-side.
 */

const isPair = (v: unknown): v is { car: unknown; cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

const isSymbol = (v: unknown): v is { __name__: string | symbol } =>
  v !== null && typeof v === "object" && "__name__" in v;

const symName = (s: { __name__: string | symbol }): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** Collect a proper-list Pair chain to a JS array. Non-pair (improper) tails are dropped. */
function toArray(p: unknown): unknown[] {
  const out: unknown[] = [];
  let cur = p;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

const headSymbolOf = (form: unknown): string | null =>
  isPair(form) && isSymbol(form.car) ? symName(form.car) : null;

/** The membrane-crossing builtins, by `EffectKind`. Calling one penetrates; referencing it as a
 *  value (e.g. `(map infer …)`) is pure until invoked. This is the `EffectKind` set of
 *  `effect-log.ts` made concrete — the loader verbs (`require`/`import`) are deliberately ABSENT:
 *  they read project-local source deterministically (composition plumbing), not a costing query.
 *  Flip them in here if "external query" should ever include the loader. */
export const PENETRATING_FORMS: ReadonlyMap<string, "infer" | "http" | "sql" | "mcp"> = new Map([
  ["infer", "infer"],
  ["infer/chat", "infer"],
  ["http/get", "http"],
  ["http/post", "http"],
  ["sql/query", "sql"],
  ["mcp/call", "mcp"],
  ["mcp/list", "mcp"],
]);

/** Built-in higher-order functions that INVOKE a function argument → the arg index that holds
 *  the function. Lets `(map infer xs)` be caught: `infer` rides in value position, but `map`
 *  calls it. User-defined HOFs are not in this table (see APPROXIMATION above). */
const HOF_FN_ARG: ReadonlyMap<string, number> = new Map([
  ["map", 0], ["for-each", 0], ["filter", 0], ["filter-map", 0], ["find", 0],
  ["count-if", 0], ["some", 0], ["every", 0], ["remove", 0], ["partition", 0], ["sort", 0],
  ["reduce", 0], ["fold", 0], ["fold-left", 0], ["fold-right", 0], ["foldl", 0], ["foldr", 0],
  ["apply", 0],
]);

/** Control forms whose effect is the OR of their evaluated sub-forms. `cond`/`case` are handled
 *  apart (their clauses are lists, not flat operands). */
const CONTROL = new Set(["if", "when", "unless", "begin", "and", "or", "do", "while"]);

type Sig = "pure" | "latent";
interface Eff {
  /** Does evaluating this form, now, in eval order, cross the membrane? */
  triggers: boolean;
  /** What the resulting VALUE does when later called (`latent`) or not (`pure`). */
  sig: Sig;
}
const PURE: Eff = { triggers: false, sig: "pure" };

/** A lexical effect-scope: symbol → `Sig`, with a parent chain (shadowing). The root holds the
 *  penetrating builtins as `latent`; cell-level defines accumulate so later forms (and, when
 *  threaded, later cells) resolve them. */
export class EffectEnv {
  private readonly m = new Map<string, Sig>();
  constructor(private readonly parent?: EffectEnv) {}
  get(name: string): Sig | undefined {
    return this.m.has(name) ? this.m.get(name) : this.parent?.get(name);
  }
  set(name: string, sig: Sig): void {
    this.m.set(name, sig);
  }
  child(): EffectEnv {
    return new EffectEnv(this);
  }
}

/** A fresh root env: the penetrating builtins bound `latent`, everything else `pure` by default
 *  (unknown symbols resolve to `pure` — `car`, `+`, `list`, … never cross the membrane). */
export function rootEffectEnv(): EffectEnv {
  const env = new EffectEnv();
  for (const name of PENETRATING_FORMS.keys()) env.set(name, "latent");
  return env;
}

/** Bind a lambda parameter spec (`(a b c)`, `(a . rest)`, or a single `args`) as `pure` in
 *  `scope`. Params are values, not effects — a penetrating fn passed IN is caught at the call
 *  that supplies it, not here. */
function bindParams(spec: unknown, scope: EffectEnv): EffectEnv {
  if (isSymbol(spec)) {
    scope.set(symName(spec), "pure");
    return scope;
  }
  let cur = spec;
  while (isPair(cur)) {
    if (isSymbol(cur.car)) scope.set(symName(cur.car), "pure");
    cur = cur.cdr;
  }
  if (isSymbol(cur)) scope.set(symName(cur), "pure"); // improper tail = rest param
  return scope;
}

/** A body / sequence: thread internal `define`s into the scope, OR the triggers, carry the last
 *  form's `sig` as the sequence's value. Mirrors how `begin`/lambda-body/let-body evaluate. */
function evalBody(forms: readonly unknown[], scope: EffectEnv): Eff {
  let triggers = false;
  let last: Eff = PURE;
  for (const form of forms) {
    last = evalForm(form, scope); // a `define` mutates `scope` and returns pure
    triggers ||= last.triggers;
  }
  return { triggers, sig: last.sig };
}

/** OR the `triggers` of a set of forms evaluated in `env`. */
function anyTriggers(forms: readonly unknown[], env: EffectEnv): boolean {
  let t = false;
  for (const f of forms) t = evalForm(f, env).triggers || t;
  return t;
}

function evalDefine(args: readonly unknown[], env: EffectEnv): Eff {
  const target = args[0];
  // `(define (name . params) body…)` — lambda sugar: pure NOW, exports a latent-iff-body binding.
  if (isPair(target) && isSymbol(target.car)) {
    const name = symName(target.car);
    const scope = bindParams(target.cdr, env.child());
    scope.set(name, "pure"); // pre-bind for self-recursion (monovariant: one pass, no fixpoint)
    const sig: Sig = evalBody(args.slice(1), scope).triggers ? "latent" : "pure";
    env.set(name, sig);
    return PURE;
  }
  // `(define name expr)` — the expr IS evaluated at definition, so `(define x (infer …))` DOES
  // trigger now; `(define f (lambda …))` binds latent without triggering.
  if (isSymbol(target)) {
    const e = args.length >= 2 ? evalForm(args[1], env) : PURE;
    env.set(symName(target), e.sig);
    return { triggers: e.triggers, sig: "pure" };
  }
  return PURE;
}

function evalLet(head: string, args: readonly unknown[], env: EffectEnv): Eff {
  // Named let `(let loop ((v e)…) body…)` — binds `loop` recursively and INVOKES immediately.
  if (head === "let" && isSymbol(args[0])) {
    const loop = symName(args[0]);
    const bindings = toArray(args[1]);
    const scope = env.child();
    let triggers = false;
    for (const b of bindings) {
      const [v, e] = toArray(b);
      const eff = e === undefined ? PURE : evalForm(e, env);
      triggers ||= eff.triggers;
      if (isSymbol(v)) scope.set(symName(v), eff.sig);
    }
    scope.set(loop, "pure"); // pre-bind; the loop is called, so body triggers count
    const body = evalBody(args.slice(2), scope);
    return { triggers: triggers || body.triggers, sig: body.sig };
  }
  const bindings = toArray(args[0]);
  const scope = env.child();
  // let* / letrec evaluate inits in the accumulating scope; plain let in the outer env.
  const initEnv = head === "let" ? env : scope;
  if (head === "letrec") for (const b of bindings) {
    const v = toArray(b)[0];
    if (isSymbol(v)) scope.set(symName(v), "pure"); // visible in inits
  }
  let triggers = false;
  for (const b of bindings) {
    const [v, e] = toArray(b);
    const eff = e === undefined ? PURE : evalForm(e, initEnv);
    triggers ||= eff.triggers;
    if (isSymbol(v)) scope.set(symName(v), eff.sig);
  }
  const body = evalBody(args.slice(1), scope);
  return { triggers: triggers || body.triggers, sig: body.sig };
}

/** Triggers inside a quasiquote template: only the `unquote` / `unquote-splicing` islands are
 *  code; the surrounding structure is data. */
function quasiTriggers(node: unknown, env: EffectEnv): boolean {
  if (!isPair(node)) return false;
  const h = headSymbolOf(node);
  if (h === "unquote" || h === "unquote-splicing") {
    return anyTriggers(toArray(node.cdr), env);
  }
  let t = false;
  let cur: unknown = node;
  while (isPair(cur)) {
    t = quasiTriggers(cur.car, env) || t;
    cur = cur.cdr;
  }
  return t;
}

/** The abstract evaluator: the effect of evaluating `form` in `env`. */
export function evalForm(form: unknown, env: EffectEnv): Eff {
  if (isSymbol(form)) return { triggers: false, sig: env.get(symName(form)) ?? "pure" };
  if (!isPair(form)) return PURE; // number / string / char / bool / nil / vector literal

  const head = headSymbolOf(form);
  const args = toArray(form.cdr);

  // --- special forms (not applications) ---
  if (head === "quote") return PURE; // data — not walked as code
  if (head === "quasiquote") return { triggers: quasiTriggers(args[0], env), sig: "pure" };
  if (head === "lambda" || head === "λ") {
    const scope = bindParams(args[0], env.child());
    return { triggers: false, sig: evalBody(args.slice(1), scope).triggers ? "latent" : "pure" };
  }
  if (head === "define") return evalDefine(args, env);
  if (head === "let" || head === "let*" || head === "letrec") return evalLet(head, args, env);
  if (head === "set!") {
    const e = args.length >= 2 ? evalForm(args[1], env) : PURE;
    if (isSymbol(args[0])) env.set(symName(args[0]), e.sig);
    return { triggers: e.triggers, sig: "pure" };
  }
  if (head === "cond" || head === "case") {
    // Each clause is a list (`(test body…)` / `((datums) body…)`); walk every element as code.
    // For `case` the leading datum-list is data, but walking it only risks a harmless
    // false-positive (the safe direction), never a missed penetration.
    let t = false;
    for (const clause of args) t = anyTriggers(toArray(clause), env) || t;
    return { triggers: t, sig: "pure" };
  }
  if (head && CONTROL.has(head)) return { triggers: anyTriggers(args, env), sig: "pure" };

  // --- application: (op . args) ---
  const opEff = evalForm(form.car, env);
  let triggers = opEff.triggers || anyTriggers(args, env);
  if (opEff.sig === "latent") triggers = true; // calling a latent operator fires the effect
  if (head && HOF_FN_ARG.has(head)) {
    const fnArg = args[HOF_FN_ARG.get(head)!];
    if (fnArg !== undefined && evalForm(fnArg, env).sig === "latent") triggers = true;
  }
  return { triggers, sig: "pure" };
}

/**
 * Analyze one cell's top-level forms against `env`, MUTATING it with the cell's top-level
 * `define`s (they're global in the shared kernel, so the next cell inherits them — thread the
 * SAME env across cells in document order to get cross-cell taint). Returns whether RUNNING the
 * cell crosses the membrane (the `▶`-worthiness).
 */
export function cellTriggers(forms: readonly unknown[], env: EffectEnv): boolean {
  let triggers = false;
  for (const form of forms) triggers = evalForm(form, env).triggers || triggers;
  return triggers;
}

/** One-shot reading for an isolated block (no cross-cell env): does running these forms cross
 *  the membrane? Equivalent to `cellTriggers(forms, rootEffectEnv())`. */
export function formsTrigger(forms: readonly unknown[]): boolean {
  return cellTriggers(forms, rootEffectEnv());
}
