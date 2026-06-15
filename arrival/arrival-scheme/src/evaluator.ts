/**
 * Generator-Based Evaluator with Flat Trampoline
 *
 * This evaluator uses a flat trampoline instead of promises or recursive generators.
 * Key benefits:
 *
 * 1. ~100x fewer promise allocations for pure Scheme code
 * 2. TRUE stack-safety via flat trampoline (not yield*)
 * 3. Event loop breathing via periodic yields
 * 4. JS interop preserved - runner awaits yielded promises
 *
 * The pattern:
 * - yield { call: generator } to invoke a sub-generator (flat, no stack growth)
 * - yield promise for JS interop (runner awaits it)
 * - yield TICK for periodic event loop breathing
 */

import invariant from "tiny-invariant";
import { AValue, unionProvenance } from "./AValue.js";
import { Environment } from "./Environment.js";
import { formatLocation, type SourceLocation } from "./errors.js";
import {
  is_callable,
  is_continuation,
  is_false,
  is_function,
  is_macro,
  is_nil,
  is_pair,
  is_parameter,
  is_promise,
  is_syntax,
} from "./guards.js";
import { HalfBaked, is_half_baked } from "./HalfBaked.js";
import { SchemeJSFunction } from "./membrane.js";
import { ArrivalError } from "./ArrivalError.js";
import { SchemeSymbol } from "./SchemeSymbol.js";
import { SchemeVector } from "./SchemeVector.js";
import { Macro } from "./Macro.js";
import { Pair } from "./Pair.js";
import { __data__, __location__ } from "./primitives.js";
import { nil, type SchemeValue } from "./types.js";

// ============================================================================
// Error Handling with Stack Traces
// ============================================================================

/**
 * Represents a frame in the Scheme evaluation stack.
 */
export interface StackFrame {
  code: SchemeValue;
  env_name?: string;
  procedure?: string;
  /** Source location if available from parsed code */
  location?: SourceLocation;
}

/**
 * Enhanced error with Scheme stack trace.
 */
export class SchemeError extends ArrivalError {
  readonly name = "SchemeError";

  constructor(
    message: string,
    public readonly schemeStack: StackFrame[],
    cause?: Error,
  ) {
    super(message);
    if (cause) {
      this.cause = cause;
    }
  }

  /**
   * Format the error with Scheme stack trace.
   */
  toString(): string {
    let result = `${this.name}: ${this.message}`;

    if (this.schemeStack.length > 0) {
      result += "\n\nScheme Stack Trace:";
      for (const [i, frame] of this.schemeStack.entries()) {
        const codeStr = formatCode(frame.code);
        const env = frame.env_name ? ` [${frame.env_name}]` : "";
        const proc = frame.procedure ? ` in ${frame.procedure}` : "";
        // Include location if available (from frame or from code's metadata)
        const loc = frame.location ?? getLocation(frame.code);
        const locStr = loc ? ` at ${formatLocation(loc)}` : "";
        result += `\n  ${i + 1}. ${codeStr}${locStr}${proc}${env}`;
      }
    }

    return result;
  }
}

/**
 * Extract source location from a Scheme value if it has one.
 */
function getLocation(code: SchemeValue): SourceLocation | undefined {
  if (code && typeof code === "object" && __location__ in code) {
    return code[__location__] as SourceLocation;
  }
  return undefined;
}

/**
 * Format Scheme code for display in stack traces.
 */
function formatCode(code: SchemeValue, maxLen = 60): string {
  if (code === null || code === undefined) return "null";
  // `is_nil` not `=== nil`: after the AValue refactor, `nil.withProvenance(p)` mints
  // fresh Nil clones (types.ts:87) — reference-equality misses them and a provenance-
  // bearing list-terminator would format as "[object Object]" in stack traces.
  // Matches the pattern adopted at line 131 below. Tier-1 fix context: 5f7f9e46a.
  if (is_nil(code)) return "()";
  if (code instanceof SchemeSymbol) return symbol_name(code);
  if (typeof code === "string") return JSON.stringify(code);
  if (typeof code === "number" || typeof code === "bigint") return String(code);
  if (typeof code === "boolean") return code ? "#t" : "#f";

  if (is_pair(code)) {
    // Format list/pair
    const parts: string[] = [];
    let node: SchemeValue = code;
    let count = 0;
    while (is_pair(node) && count < 5) {
      parts.push(formatCode(node.car, 20));
      node = node.cdr;
      count++;
    }
    if (is_pair(node)) {
      parts.push("...");
    } else if (!is_nil(node)) {
      parts.push(".");
      parts.push(formatCode(node, 20));
    }
    const result = `(${parts.join(" ")})`;
    return result.length > maxLen ? `${result.slice(0, maxLen - 3)}...` : result;
  }

  return String(code).slice(0, maxLen);
}

// ============================================================================
// Types
// ============================================================================

/**
 * Opaque tag for one dynamic evaluation of an AST node. The tap implementation
 * defines its shape; the evaluator only threads it through as the parent of
 * nested invocations.
 */
export type Invocation = unknown;

/**
 * Tap callback surface for tracing evaluation. The evaluator fires `enter`
 * before evaluating a parsed Pair (one carrying a __location__ marker), and
 * `exit` when that Pair's evaluation completes — synchronously or after
 * arbitrary async work, with either a value or an error.
 */
export interface EvalTap {
  /**
   * `tailPosition` surfaces the evaluator's ground-truth: this Pair is being
   * evaluated in tail position (R7RS §3.5), so a call here is a tail call. The
   * trace uses it to identify tail-recursive loops precisely — don't infer TCO
   * from the flattened parent structure, read the flag the evaluator already
   * computes for the trampoline. Optional for backward-compat with taps that
   * don't care.
   */
  enter(node: Pair, parent: Invocation | null, tailPosition?: boolean): Invocation;
  /**
   * Returning a value-shaped result substitutes the evaluator's outgoing value
   * for the invocation. Used by provenance plumbing: the tap stamps the result
   * with computed provenance and the substitution flows that stamp into the
   * binding the evaluator is about to create.
   *
   * Why this matters: provenance is computed at exit time (it depends on
   * children's provenance + symbolContributions accumulated during the call,
   * neither of which exists at enter time). The tap stamps a NEW AValue
   * carrying that provenance via `withProvenance`. Without substitution the
   * evaluator continues with the original, un-stamped result, and the
   * provenance never reaches the next env binding — so downstream
   * `onSymbolResolved` reads empty provenance and lineage breaks at the
   * (define greeting (car (infer …))) boundary. Tap-as-transformer is what
   * lets a primitive-shaped binding inherit its producer's provenance.
   */
  exit(
    invocation: Invocation,
    result: { value: SchemeValue } | { error: unknown },
  ): { value: SchemeValue } | { error: unknown } | void;
  /**
   * Fired when a SchemeSymbol is resolved during evaluation, attributed to
   * the currently-entered Pair invocation (or null if at top level). Useful
   * for tracers that need symbol values in the lineage — symbol eval is the
   * one path that doesn't fire enter/exit, so without this method the
   * resolved value never reaches the tap.
   */
  onSymbolResolved?(invocation: Invocation | null, symbol: SchemeSymbol, value: SchemeValue): void;
}

/** Evaluation context passed through the evaluator */
export interface EvalContext {
  env: Environment;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  error?: (e: Error, code?: SchemeValue) => void;
  /** Stack frames for error reporting */
  _stack?: StackFrame[];
  /** Optional tap for tracing evaluation enter/exit per parsed Pair. */
  tap?: EvalTap;
  /**
   * Optional filter — when present, returning false skips tap firing for a node
   * (atoms and macro-expansion-constructed Pairs are always skipped regardless).
   */
  nodeFilter?: (node: Pair) => boolean;
  /** Current dynamic-stack invocation; sub-evaluations receive this as parent. */
  currentInvocation?: Invocation;
  /**
   * Optional execution-budget signal. When `signal.aborted` becomes true the
   * trampoline throws `signal.reason ?? DOMException("aborted", "AbortError")`
   * at the next iteration boundary (the existing 1000-iter / 5ms event-loop
   * yield in `run()` — see the war story there). Composes with Web APIs at
   * the rosetta boundary: `fetch(url, { signal: ctx.signal })` becomes
   * natural, so a single AbortController can cancel both Scheme execution
   * and any in-flight host requests it spawned.
   *
   * Without this, `(define (loop) (loop))` runs forever — the 5ms yield
   * gives the event loop room to breathe but does not bound CPU; sandbox
   * code and agent-generated programs need an actual bound.
   */
  signal?: AbortSignal;
  /**
   * Tail-position flag (R7RS §3.5). True when this expression's value is the
   * value of an enclosing lambda/let body — i.e. when a procedure call here
   * is a tail call and should not grow the host stack. Propagation is
   * structural: `begin`'s last expr inherits the parent flag, `if`'s chosen
   * arm inherits, `and`/`or`'s last expr inherits, `cond`/`case`/`when`/
   * `unless` matched-body inherits, `let`/`let*`/`letrec`/`letrec*` bodies
   * inherit (they desugar to `begin`), `do`'s termination-result inherits.
   * Predicate evaluation and earlier `begin`/`and`/`or` expressions do NOT
   * inherit — only the final expression in tail position does.
   *
   * Read at evaluatePair to decide between `{ call }` (push as sub-call) and
   * `{ tailCall }` (replace this slot) when the callable is a Scheme lambda.
   */
  tail?: boolean;
  /**
   * Speculative-evaluation flag (Tier 2 — see
   * `docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md`).
   * When false/absent (the default) the evaluator is byte-identical to today:
   * collection operators resolve their promise fans eagerly to a `Pair`. When
   * true, `filter`/`map`/`list` may return a `HalfBaked` lazy carrier so that
   * `length` + comparison + `if` can collapse control flow early, before the fan
   * fully settles. The carrier is forced at any operator that does not understand
   * it (force-on-unknown-boundary), so speculation-off ≡ speculation-on for every
   * observable channel — this flag only changes *latency*, never values or
   * effects. Propagated structurally like `tail`.
   */
  speculate?: boolean;
}

/** Options for the trampoline runner (`run`). */
export interface RunOptions {
  /**
   * Execution-budget signal. See `EvalContext.signal` for the war story.
   * Threaded as a runner option (not via the generator) because the
   * trampoline lives outside any single `EvalContext` — generators created
   * by sub-evaluations carry their own ctx, but the budget is per-run.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock execution budget in milliseconds. When set, the trampoline
   * starts a deadline at `performance.now() + budgetMs` and throws a
   * `SchemeError(/budget/)` once the deadline passes — checked at the SAME
   * iteration boundary as the abort signal (the 1000-iter / 5ms TICK
   * cadence), so it costs nothing on the hot path and bounds
   * `(let loop () (loop))` to within one cadence unit.
   *
   * This is the "L0" host bound: an `AbortSignal` lets an EXTERNAL controller
   * cancel (UI cancel button, parent `fetch` abort), but sandbox / agent code
   * needs an INTERNAL bound that fires even when nobody is holding a
   * controller. `budgetMs` is that bound — independent of, and composable
   * with, `signal` (whichever fires first wins).
   */
  budgetMs?: number;
  /**
   * Opt into Tier 2 speculative evaluation for this run (see `EvalContext.speculate`).
   * Default false = byte-identical to today. Set on the root `EvalContext` and
   * propagated structurally; consumed by the collection operators + comparison
   * membrane. Latency-only: never changes values or fired effects.
   */
  speculate?: boolean;
}

/**
 * Module-level dynamic call site holder. Set by evaluatePair just before
 * invoking a callable, read by evalLambda / named-let loopFn when building
 * the body ctx so that a lambda's body runs with the DYNAMIC parent invocation
 * (the call site) rather than the LEXICAL one captured at lambda-creation.
 *
 * Why: when a native JS HOF (map/filter/reduce) iterates over a user lambda,
 * the lambda's body would otherwise inherit currentInvocation from the lexical
 * ctx (e.g., the enclosing define), severing the parent chain at the HOF
 * boundary. With this holder, the lambda picks up the calling Pair's
 * invocation, so DNF path reconstruction can surface HOF iteration via
 * parent-walking.
 *
 * Single-threaded JS makes a module-level holder safe; we save/restore around
 * each apply to handle nesting.
 */
let _dynamicCallSite: Invocation | undefined = undefined;

/**
 * Module-level "may return a Bounce" flag — set by evaluatePair RIGHT BEFORE
 * invoking a Scheme lambda from inside an active trampoline, cleared in the
 * surrounding finally. When a Scheme lambda's JS body observes this true, it
 * skips its own `run(...)` call and returns a Bounce token instead — the
 * outer trampoline then drives the body generator without growing the host
 * call stack via a Promise chain.
 *
 * Why a per-call flag and not just `_inTrampoline`: Scheme lambdas can be
 * called back from JS HOFs (map/filter/reduce/native rosetta wrappers) that
 * iterate inside a single trampoline tick. Those callers don't know about
 * Bounce tokens — they treat the lambda's return as a SchemeValue (or a
 * Promise to thread). So bouncing must be opt-in at the call site that
 * speaks the protocol: evaluatePair (the Scheme-to-Scheme call boundary).
 * evaluatePair sets the flag true only when fn.__lambda__ is true AND we're
 * about to invoke from inside the trampoline; HOFs that subsequently call
 * back into lambdas see the flag back to false (restored in finally), so
 * those calls go through the normal `run(...)` Promise path and HOF code
 * stays oblivious.
 *
 * Single-threaded JS makes a module-level holder safe; the save/restore
 * around each apply handles nesting, mirroring `_dynamicCallSite`'s pattern.
 */
let _canBounce = false;

/**
 * Tier-2 speculation flag, read synchronously by producer builtins (filter/map
 * in lips.ts) at apply time to decide whether to emit a lazy `HalfBaked` carrier
 * instead of awaiting the whole promise fan. Module-level (not `__withCtx`) so
 * variadic / HOF / value uses of the producers see it without a wrapper that
 * would break their arity. Saved/restored around each apply, mirroring
 * `_canBounce`. Off by default → eager, byte-identical path. See
 * docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md.
 */
let _speculate = false;

/** Producer builtins read this synchronously at apply time. */
export const isSpeculating = (): boolean => _speculate;

/**
 * Re-install `_dynamicCallSite` on every invocation of a lambda passed as
 * an arg. Native HOFs like reduce/fold/find recurse via promise chains
 * (lips.ts:3593 `unpromise(fn(acc, x)).then(recurse)`), so iteration N+1
 * fires from a microtask AFTER the outer evaluatePair's finally has
 * restored the holder. Without per-call re-install, the lambda body for
 * iteration ≥1 would inherit the WRONG dynamic parent.
 *
 * Wrapping is cheap (function allocation per HOF arg), and copies the
 * lambda metadata so __lambda__ / __name__ / __params__ stay introspectable.
 */
function wrapLambdaArgs(args: SchemeValue[], dynSite: Invocation | undefined): SchemeValue[] {
  let out: SchemeValue[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === "function" && (a as { __lambda__?: boolean }).__lambda__) {
      if (!out) out = [...args];
      out[i] = wrapLambda(a as LambdaFunction, dynSite);
    }
  }
  return out ?? args;
}

/** Is `a` a strict descendant of `b` in the invocation tree? Walks `a`'s parent
 *  chain looking for `b`. Used to pick the deeper of two candidate dynamic call
 *  sites in `wrapLambda` (the genuine nested call site vs the HOF boundary). */
function isStrictDescendant(a: Invocation | undefined, b: Invocation | undefined): boolean {
  if (!a || !b) return false;
  // `Invocation` is opaque (`unknown`) to the evaluator — the tap owns its shape —
  // but every tap invocation exposes a `parent` link; narrow structurally to walk it.
  type ParentLinked = { parent: ParentLinked | null };
  for (let p = (a as ParentLinked).parent; p; p = p.parent) if (p === b) return true;
  return false;
}

function wrapLambda(lambda: LambdaFunction, dynSite: Invocation | undefined): LambdaFunction {
  const wrapped: LambdaFunction = function (this: unknown, ...values: SchemeValue[]): SchemeValue {
    const saved = _dynamicCallSite;
    // Prefer the DEEPER of the two candidate dynamic parents. `dynSite` is the
    // HOF boundary — where the lambda was passed in (e.g. `index-map`'s call
    // site). `saved` is whatever the immediate caller set: for a genuine
    // Scheme-to-Scheme call `(f i x)`, the inner evaluatePair has already
    // stamped it with THAT call's invocation — a descendant of `dynSite`,
    // sitting inside the loop iteration that actually invoked the lambda.
    //
    // Keeping `saved` when it's a descendant places the body under its real
    // call site (so a loop's per-iteration work nests under the iteration,
    // not at the outer pass-in frame — without this a TCO loop that calls a
    // passed-in lambda scatters its work to the driver). The native-HOF escape
    // (map/filter/reduce iterating from JS with no Scheme call Pair) leaves
    // `saved` equal to `dynSite` or absent, so it falls through to `dynSite`
    // unchanged. See the bug write-up: arrival-chain index-map fan-out.
    _dynamicCallSite = isStrictDescendant(saved, dynSite) ? saved : dynSite;
    try {
      return lambda.apply(this, values);
    } finally {
      _dynamicCallSite = saved;
    }
  };
  wrapped.__lambda__ = true;
  if (lambda.__name__) wrapped.__name__ = lambda.__name__;
  if (lambda.__params__) wrapped.__params__ = lambda.__params__;
  return wrapped;
}

/** Interface for functions created by lambda */
/**
 * Marker for builtins that understand a `HalfBaked` arg and must NOT have it
 * forced at the dispatch choke (Tier 2 speculation). Set on `length` (reads the
 * cardinality interval) and the comparison ops (return an early-decision promise).
 * Every other callable receives forced, settled values — force-on-unknown-boundary.
 */
interface SpeculationAware {
  __speculate__?: boolean;
}

interface LambdaFunction {
  __lambda__?: boolean;
  __name__?: string;
  /**
   * Positional parameter names captured at lambda creation. Empty for
   * variadic-only lambdas. Used by tracers to correlate a symbol use inside
   * the body with the lambda parameter it binds — see arrival-chain
   * lineage's iteration-element classification.
   */
  __params__?: readonly string[];

  (...args: SchemeValue[]): SchemeValue;
}

/** Interface for macro expansion result */
interface DataMarked {
  [__data__]?: boolean;
}

/** Type guard for DataMarked objects */
function is_data_marked(o: unknown): o is DataMarked {
  if (o === null || typeof o !== "object") return false;
  // The data mark is the `__data__` SYMBOL (Symbol.for("__data__")), set by
  // quote() and read by legacy evaluate_macro as `value?.[__data__]`. The earlier
  // string-key check ("__data__" in o) never matched the symbol — invisible for
  // any normal (quote x) because that hits evalQuote (a special form) and skips
  // this macro path, but a hygiene-gensym'd `#:quote` resolves to the quote Macro
  // and DOES take this path, so the mismatch made the generator re-evaluate
  // quoted data inside syntax-rules expansions.
  return (o as Record<symbol, unknown>)[__data__] === true;
}

/** Type guard for LambdaFunction */
function is_lambda_function(o: unknown): o is LambdaFunction {
  return typeof o === "function";
}

/** The evaluator generator type - third param is what yield returns */
export type EvalGenerator = Generator<unknown, SchemeValue, SchemeValue>;

/** Symbol to mark a yield as "need to check time" vs "await this promise" */
const TICK = Symbol("tick");

/** Marker for sub-generator calls (flat trampoline) */
interface Call {
  call: Generator<unknown, unknown, unknown>;
  /** Optional stack frame for error reporting */
  frame?: StackFrame;
  /**
   * Fired by the trampoline when the sub-generator returns normally.
   * Returning a value substitutes the outgoing result (the trampoline uses
   * the returned value as `valueToSend` to the parent generator). Returning
   * `undefined` is the "no substitution" signal — taps cannot substitute
   * with undefined, which is fine since undefined isn't a meaningful Scheme
   * value to thread through a binding. See `EvalTap.exit` for the war
   * story on why tap-as-transformer is load-bearing for provenance.
   */
  onResolve?: (value: unknown) => unknown | undefined;
  /**
   * Fired by the trampoline when the sub-generator (or its descendants)
   * throws. The return type mirrors `onResolve` for shape symmetry, but the
   * rejection path doesn't currently use the substitution; v0 only needs
   * the resolved-value transformer to close the lineage gap.
   */
  onReject?: (error: unknown) => unknown | undefined;
  /**
   * Tail-position marker (R7RS §3.5). True when the YIELDING generator does
   * nothing but return this sub-call's result (a local pass-through —
   * `return yield { call }`, modulo `onResolve`). The trampoline uses this
   * to COLLAPSE the chain when a tail call bubbles up: it pops all
   * consecutive `tail: true` slots down to the first slot that will do real
   * work after its child returns (an argument collector, a predicate eval,
   * a binding RHS — none of those are marked tail). The popped slots'
   * `onResolve`/`onReject` hooks compose onto the replacement slot so taps
   * stay enter/exit balanced and provenance transforms still fire when the
   * tail chain eventually returns.
   *
   * Why this matters for O(1) space: a lambda body that tail-calls itself
   * sits under a fixed-depth tower of pass-through slots (begin → if →
   * evaluate → evaluatePair). Without collapse, each recursion would stack
   * a fresh tower and `stack[]` would grow O(depth) — which is exactly the
   * accumulation that made the first naive tailCall implementation return
   * `undefined` and OOM at ~100 levels. Collapsing the tower per iteration
   * keeps `stack[]` bounded.
   */
  tail?: boolean;
}

function is_call(o: unknown): o is Call {
  return o !== null && typeof o === "object" && "call" in o;
}

/**
 * Marker for tail calls — yielded by evaluatePair when a Scheme-to-Scheme
 * call lands in tail position (R7RS §3.5). The trampoline REPLACES the
 * current slot with the callee generator instead of stacking it: the tail
 * call doesn't return THROUGH the caller, it returns IN PLACE OF the caller.
 *
 * War story on the semantics: a tail call is identity-of-result, not nest-
 * and-return. The slot we pop is the one that was about to compute the call
 * and then immediately return its result; replacing it preserves both the
 * "stack budget stays flat" guarantee (no growth per recursion level) AND
 * the data-flow invariant that the eventual return value flows up through
 * the ORIGINAL consumer. To keep the data flow correct we move the popped
 * slot's `onResolve` to the new slot — that way when the tail body finally
 * returns, the caller's caller (the original consumer of the tail-position
 * expression's value) sees the value via the same hook that would have
 * fired if the call had been a normal sub-call. Without this transfer, the
 * tap-substitution chain breaks at every tail-recursive step and provenance
 * stamping disappears for any value flowing through a tight loop.
 *
 * onReject moves the same way: an exception in the tail body should be
 * delivered to the surviving consumer, not to the popped (now-gone) slot.
 *
 * Frame stack: the popped slot's frame goes away (we're no longer "inside"
 * the popped function — it's done by definition once it tail-calls), and
 * the new frame represents the calling Pair (e.g. `(loop n)`) so the stack
 * trace still describes who initiated the tail dispatch. EvalTap.exit fires
 * on that popped frame BEFORE we push the new one (lineage stays intact via
 * the popped slot's invocation stamp).
 */
interface TailCall {
  tailCall: {
    generator: Generator<unknown, unknown, unknown>;
    /** Frame attributed to the call site that initiated the tail dispatch. */
    frame?: StackFrame;
  };
}

function is_tailCall(o: unknown): o is TailCall {
  return o !== null && typeof o === "object" && "tailCall" in o;
}

/**
 * Sentinel returned by a Scheme lambda's JS function body when `_canBounce`
 * was true at invocation time — i.e. when the calling evaluatePair speaks
 * the bounce protocol and is willing to route the body generator back into
 * the active trampoline. Bypasses the `run(evalBegin(body, ctx))` path that
 * would otherwise mint a fresh Promise and grow the host stack one await
 * per recursive call. See `_canBounce`'s war story for why HOF callbacks
 * must NOT see this token.
 */
interface Bounce {
  __bounce: true;
  generator: Generator<unknown, unknown, unknown>;
}

function is_bounce(o: unknown): o is Bounce {
  return o !== null && typeof o === "object" && (o as { __bounce?: unknown }).__bounce === true;
}

/**
 * Wrap a lambda body generator as a Bounce token. Used by evalLambda and
 * named-let loopFn when `_canBounce` is true — see the war story on the
 * flag and on Bounce for the invariants this preserves.
 */
function makeBounce(generator: Generator<unknown, unknown, unknown>): Bounce {
  return { __bounce: true, generator };
}

/**
 * Scheme promise (delay/force) - NOT a JS Promise!
 * This represents a lazily evaluated expression.
 */
export class SchemePromise {
  private _value: SchemeValue = undefined;
  private readonly _thunk: () => SchemeValue;

  constructor(thunk: () => SchemeValue) {
    this._thunk = thunk;
  }

  private _forced = false;

  get forced(): boolean {
    return this._forced;
  }

  force(): SchemeValue {
    if (!this._forced) {
      this._value = this._thunk();
      this._forced = true;
    }
    return this._value;
  }
}

export function is_scheme_promise(o: unknown): o is SchemePromise {
  return o instanceof SchemePromise;
}

// ============================================================================
// Symbol name extraction
// ============================================================================

function symbol_name(sym: SchemeSymbol): string {
  const name = sym.__name__;
  return typeof name === "symbol" ? name.description || "" : name;
}

// ============================================================================
// Environment lookup without lips runtime dependency
// ============================================================================

/**
 * Look up a symbol in the environment without requiring lips runtime.
 * This uses _lookupWithResolvers directly to avoid patch_value.
 * For keyword symbols (:name), delegates to env.get() which creates accessor functions.
 */
function env_get(env: Environment, sym: SchemeSymbol): SchemeValue {
  const name = sym.__name__;

  // Handle keyword symbols (e.g., :name, :projects) — delegate to env.get()
  // which creates Clojure-style property accessor functions
  if (typeof name === "string" && name.startsWith(":")) {
    return env.get(sym);
  }

  const value = env._lookupWithResolvers(name);
  if (value !== undefined) {
    return value;
  }

  // Direct lookup missed. Dot-notation symbols — `foo.bar.baz` source sugar, or the
  // syntax-rules gensyms that carry their property path on SchemeSymbol.object — are
  // resolved by Environment.get's property-splitting path, which _lookupWithResolvers
  // does not implement. Delegate ONLY after the direct miss (matching Environment.get's
  // "dot notation only after direct lookup fails" ordering), so the hot path is unchanged.
  const hasObjectParts =
    (sym as unknown as { [key: symbol]: unknown })[SchemeSymbol.object] != null;
  if (hasObjectParts || (typeof name === "string" && name.includes("."))) {
    return env.get(sym);
  }

  invariant(false, `Unbound variable \`${String(name)}'`);
}

// ============================================================================
// Flat Trampoline Runner
// ============================================================================

/**
 * Run a generator-based evaluator to completion using a FLAT trampoline.
 *
 * This is the core trampoline that:
 * 1. Maintains a stack of generators (no call stack growth!)
 * 2. Handles { call: generator } yields by pushing to stack
 * 3. Awaits any yielded promises (from JS interop)
 * 4. Periodically yields to the event loop (every ~5ms)
 * 5. Tracks stack frames for error reporting
 * 6. Honors an optional AbortSignal at iteration boundaries
 */
async function run<T>(
  generator: Generator<unknown, T, unknown>,
  options: RunOptions = {},
): Promise<T> {
  const { signal, budgetMs } = options;

  // Fast-fail: if the caller passed an already-aborted signal, refuse
  // before allocating the trampoline state. Mirrors fetch() semantics.
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }

  // Wall-clock deadline. `undefined` when no budget was requested, so the
  // per-TICK comparison short-circuits to a single `!== undefined` check.
  // A non-positive budget means "already expired" — refuse on entry, the
  // budget analogue of the pre-aborted-signal fast path above.
  const deadline =
    budgetMs === undefined ? undefined : performance.now() + budgetMs;
  if (deadline !== undefined && budgetMs! <= 0) {
    throw new SchemeError(`execution budget exceeded (${budgetMs}ms)`, []);
  }

  // Stack of generators - this is the key to flat trampolining
  const stack: Generator<unknown, unknown, unknown>[] = [generator];
  // Stack frames for error reporting (parallel to generator stack)
  const frameStack: (StackFrame | undefined)[] = [undefined];
  // Calls that pushed each generator (root has none). Carries onResolve/onReject hooks.
  const callStack: (Call | undefined)[] = [undefined];
  let lastYield = performance.now();
  let iterations = 0;
  let valueToSend: unknown = undefined;

  // Fire onReject up the call stack so any tap subscribers see the error,
  // then build the wrapped SchemeError to throw out of run().
  const failAndWrap = (error: unknown): never => {
    // Snapshot stack frames BEFORE popping so SchemeError carries the trace.
    const frames = frameStack.filter((f): f is StackFrame => f !== undefined);
    while (callStack.length > 0) {
      const c = callStack.pop();
      stack.pop();
      frameStack.pop();
      try {
        c?.onReject?.(error);
      } catch {
        // Swallow tap exceptions — they must not mask the real error.
      }
    }
    if (error instanceof SchemeError) throw error;
    throw error instanceof Error
      ? new SchemeError(error.message, frames, error)
      : new SchemeError(String(error), frames, undefined);
  };

  try {
    while (stack.length > 0) {
      const current = stack.at(-1)!;
      let result: IteratorResult<unknown, unknown>;

      try {
        result = current.next(valueToSend);
      } catch (error) {
        failAndWrap(error);
        return undefined as never; // unreachable
      }

      valueToSend = undefined; // Reset after use

      if (result.done) {
        // Generator finished - fire onResolve, pop, pass result to parent.
        // If onResolve returns a value, substitute it: the tap may have
        // stamped a freshly-cloned AValue with provenance computed only at
        // exit time, and that stamp has to ride into the parent's binding
        // (otherwise the original un-stamped result wins). `undefined`
        // means "no substitution" — see Call.onResolve docstring.
        const finishedCall = callStack.at(-1);
        let finalValue = result.value;
        if (finishedCall?.onResolve) {
          try {
            const subst = finishedCall.onResolve(result.value);
            if (subst !== undefined) finalValue = subst;
          } catch {
            // Tap exceptions must not break evaluation.
          }
        }
        stack.pop();
        frameStack.pop();
        callStack.pop();
        valueToSend = finalValue;
        continue;
      }

      const value = result.value;

      // Check for sub-generator call (flat trampoline)
      if (is_call(value)) {
        stack.push(value.call);
        frameStack.push(value.frame); // Track frame
        callStack.push(value);
        continue;
      }

      // Tail-call dispatch (R7RS §3.5). A Scheme lambda was invoked in tail
      // position; the callee's eventual return value IS the result of the
      // whole tail-position chain, so rather than stack the callee and return
      // through every intermediate frame, we COLLAPSE the chain.
      //
      // War story — why collapse, not single-slot replace: the first naive
      // version popped ONLY the slot that yielded the tailCall and pushed the
      // callee in its place. But that slot sits at the BOTTOM of a fixed tower
      // of pass-through frames built every iteration: the lambda body's
      // `begin`, the `if` whose tail arm is the recursive call, the `evaluate`
      // wrappers. Replacing only the innermost slot left the tower standing,
      // so `stack[]` grew O(depth) per recursion — the loop returned
      // `undefined` (value lost in the orphaned tower) and OOM'd at ~100
      // levels. Real TCO must unwind the ENTIRE tail tower down to the first
      // frame that still has work to do after its child returns.
      //
      // Mechanism: every pass-through `{ call }` is tagged `tail: true` (the
      // yielding code does nothing but `return yield { call }`). We pop the
      // current slot plus all consecutive `tail: true` slots beneath it,
      // stopping at the first NON-tail slot — an argument collector, a
      // predicate eval, a binding RHS, or the root — which genuinely consumes
      // the value. The callee is pushed ON TOP of that consumer, so its
      // return flows to the right place.
      //
      // Hooks: each popped slot may carry an `onResolve` (tap.exit /
      // provenance stamp) and `onReject`. We COMPOSE them (innermost first)
      // onto the replacement slot so they fire when the tail chain finally
      // returns — keeping tap enter/exit balanced and provenance transforms
      // intact. In the common no-tap case every popped slot's hooks are
      // undefined, so the composition is empty and this stays O(1) per
      // iteration (the whole point — no per-level closure retention).
      //
      // EvalTap note: taps still see every regular call boundary. For tail
      // sites the popped frames' exits are deferred to the composed hook
      // rather than fired eagerly — lineage stays intact because each
      // popped slot's invocation stamp was already recorded at enter time.
      if (is_tailCall(value)) {
        // Collect pass-through hooks while unwinding the tail tower.
        const resolvers: Array<(value: unknown) => unknown | undefined> = [];
        const rejecters: Array<(error: unknown) => unknown | undefined> = [];
        // Pop the slot that yielded the tailCall first (it is pass-through by
        // construction — evaluatePair does `return yield { tailCall }`).
        {
          const c = callStack.pop();
          stack.pop();
          frameStack.pop();
          if (c?.onResolve) resolvers.push(c.onResolve);
          if (c?.onReject) rejecters.push(c.onReject);
        }
        // Then pop consecutive pass-through (tail) slots until the first
        // slot that consumes the value (non-tail) or the root.
        while (callStack.length > 0 && callStack.at(-1)?.tail === true) {
          const c = callStack.pop();
          stack.pop();
          frameStack.pop();
          if (c?.onResolve) resolvers.push(c.onResolve);
          if (c?.onReject) rejecters.push(c.onReject);
        }
        // Compose hooks (innermost first → outermost last) so the value
        // threads through them in the same order it would have on a normal
        // return walk back up the popped tower.
        const composedResolve =
          resolvers.length === 0
            ? undefined
            : (v: unknown): unknown | undefined => {
                let acc = v;
                for (const r of resolvers) {
                  const subst = r(acc);
                  if (subst !== undefined) acc = subst;
                }
                return acc === v ? undefined : acc;
              };
        const composedReject =
          rejecters.length === 0
            ? undefined
            : (e: unknown): unknown | undefined => {
                for (const r of rejecters) r(e);
                return undefined;
              };
        const replacement: Call = {
          call: value.tailCall.generator,
          frame: value.tailCall.frame,
          onResolve: composedResolve,
          onReject: composedReject,
          // The replacement is itself pass-through w.r.t. whatever consumer
          // now sits beneath it — so a tail call from INSIDE the new body
          // continues to collapse correctly.
          tail: true,
        };
        stack.push(replacement.call);
        frameStack.push(replacement.frame);
        callStack.push(replacement);
        continue;
      }

      // If yielded value is a promise (from JS interop), await it
      if (is_promise(value)) {
        try {
          valueToSend = await value;
        } catch (error) {
          failAndWrap(error);
          return undefined as never; // unreachable
        }
        lastYield = performance.now(); // Reset timer after async
        iterations = 0;
        continue;
      }

      if (value === TICK) {
        // Explicit tick - check if we should yield to event loop
        iterations++;
        // Yield every 1000 iterations or 5ms, whichever comes first.
        //
        // WHY check the abort signal HERE rather than per-step: TICK fires at
        // every loop-step / tail-call boundary in long-running Scheme code,
        // which is exactly the granularity an infinite-loop body would hit.
        // Per-step (every `current.next()` call) the check would burn ~1-2%
        // CPU on signal.aborted reads that 99.999% of the time are false;
        // at TICK boundaries it costs nothing and still bounds (let loop
        // () (loop)) within one budget unit. The same logic applies for the
        // event-loop yield itself — the 1000-iter / 5ms cadence IS the
        // natural abort-check cadence.
        if (iterations > 1000 || performance.now() - lastYield > 5) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException("aborted", "AbortError");
          }
          // Budget check rides the SAME cadence as the abort check — see the
          // WHY-HERE note above. `now` is reused for the yield-timer reset so
          // we read the clock once. A SchemeError (not DOMException) because a
          // budget overrun is OUR policy, not a Web-standard cancellation, and
          // its `/budget/` message is what `exec(code, { budgetMs })` callers
          // (and the sandbox-escape suite) match on.
          const now = performance.now();
          if (deadline !== undefined && now > deadline) {
            throw new SchemeError(
              `execution budget exceeded (${budgetMs}ms)`,
              frameStack.filter((f): f is StackFrame => f !== undefined),
            );
          }
          await Promise.resolve(); // Minimal yield - just microtask
          lastYield = now;
          iterations = 0;
        }
        continue;
      }

      // Regular value - send it back to the generator
      valueToSend = value;
    }

    return valueToSend as T;
  } catch (error) {
    // Final catch - ensure all errors have stack traces
    if (error instanceof SchemeError) {
      throw error;
    }
    const frames = frameStack.filter((f): f is StackFrame => f !== undefined);
    throw error instanceof Error
      ? new SchemeError(error.message, frames, error)
      : new SchemeError(String(error), frames, undefined);
  }
}

export default run;

// Why no sync runner: the env carries promise-returning callables (rosettas,
// `infer`, host fetch). A sync trampoline can only honor pure scheme — the
// first yielded promise must throw "Unexpected promise," which makes sync mode
// a foot-gun that silently works for trivial expressions and fails on anything
// real. The AbortSignal budget reinforces the asymmetry: it relies on the
// event-loop yield cadence inside `run()`, so a sync path can't be cancelled
// at the same granularity. We keep one path — async — and pay the microtask
// cost everywhere rather than maintain a half-working escape hatch that drifts
// out of sync with the async semantics it pretends to mirror.

// ============================================================================
// Special Form Handlers
// ============================================================================

/**
 * Stamp the chosen arm's AValue result with `union(predicate, armResult)`.
 *
 * Per spec §5.3 (control-flow restriction): branching forms must not pollute
 * the result's lineage with provenance from arms that never ran. Without this,
 * binding `(if (= count 3) low high)` to a name would pin BOTH `low` and
 * `high` as ancestors of the bound value — including the path the predicate
 * proved unreachable. The Heisenberg-style "every possible past contributed"
 * reading breaks variant-lineage debugging downstream (arrival-chain DNF path
 * reconstruction would surface phantom contributors).
 *
 * The tap-level provenance computation already gets this right "for free":
 * only entered children fire enter/exit, so `computeProvenance` reading from
 * `inv.children` naturally excludes unchosen arms. THIS function exists for
 * the SECOND channel — the value flowing back into env bindings. When the
 * result binds to a symbol via `define`/`let`, `onSymbolResolved` reads
 * `value.provenance` directly (not the if-invocation's provenance), so the
 * value itself must carry the union(pred, arm) stamp before the binding fires.
 *
 * The two channels are complementary: tap for invocation provenance, value
 * stamping for symbol-binding provenance. Both must restrict to (pred, arm).
 */
function restrictControlFlowProvenance(predicate: SchemeValue, armResult: SchemeValue): SchemeValue {
  if (!(armResult instanceof AValue)) return armResult;
  if (!(predicate instanceof AValue) || predicate.provenance.size === 0) return armResult;
  const prov = unionProvenance([predicate, armResult]);
  // unionProvenance returns the same reference when only one distinct set
  // contributed — no allocation needed unless the predicate genuinely adds
  // new origin ids the arm didn't already carry.
  return prov === armResult.provenance ? armResult : armResult.withProvenance(prov);
}

/**
 * Build the `onResolve` hook that applies control-flow provenance restriction
 * to a branch arm result — but ONLY when the predicate actually carries
 * provenance. When it doesn't (the overwhelmingly common no-tap / plain-value
 * case), return `undefined` so the branch's tail `{ call }` carries no hook.
 *
 * Why this matters for TCO: branch arms run in tail position, so the arm's
 * `{ call }` is marked `tail: true` and may collapse when the arm tail-calls
 * a lambda. Collapsed slots' `onResolve` hooks are RETAINED as composed
 * closures on the replacement slot (so the transform still fires when the
 * tail chain returns). If we attached a hook unconditionally, a deep tail
 * loop threaded through `if`/`cond`/`when` would accumulate one closure per
 * iteration — O(n) memory, defeating the constant-space guarantee. Returning
 * `undefined` for the no-provenance case keeps the steady-state loop O(1);
 * provenance-bearing predicates (rare in a tight loop) pay the O(n) cost,
 * which the spec accepts as reduced tail-loop fidelity.
 *
 * The post-yield call site that previously wrote
 * `return restrictControlFlowProvenance(testResult, armResult)` now just
 * returns `armResult` — the trampoline applies this hook before sending the
 * value back, so the transform already happened for the non-collapsed path.
 */
function controlFlowResolve(
  predicate: SchemeValue,
): ((value: unknown) => unknown | undefined) | undefined {
  if (!(predicate instanceof AValue) || predicate.provenance.size === 0) return undefined;
  return (value: unknown): unknown | undefined => {
    const stamped = restrictControlFlowProvenance(predicate, value as SchemeValue);
    return stamped === value ? undefined : stamped;
  };
}

/**
 * Handle 'if' special form: (if test then else?)
 *
 * R7RS §3.5 tail-position propagation: the chosen arm inherits the parent's
 * tail flag — `(if p tail-call other)` in tail position means `tail-call`
 * (when p is truthy) is still in tail position. The predicate is NOT in
 * tail position; its value is consumed by the if itself, so we strip tail.
 */
function* evalIf(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "if: missing test expression");

  const testExpr = rest.car;
  const restAfterTest = rest.cdr;

  invariant(is_pair(restAfterTest), "if: missing then expression");

  const thenExpr = restAfterTest.car;
  const elseRest = restAfterTest.cdr;
  const elseExpr = is_pair(elseRest) ? elseRest.car : undefined;

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Evaluate test (non-tail — its value is consumed by the if dispatch).
  let testResult = yield { call: evaluate(testExpr, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  // Evaluate appropriate branch — inherits the if's own tail flag. The arm's
  // call is pass-through (tail-collapsible); the provenance restriction rides
  // as `onResolve` so it fires whether the arm tail-calls (collapsed) or
  // returns a plain value (resumed). See controlFlowResolve for the war story.
  const onResolve = controlFlowResolve(testResult);
  const inTail = ctx.tail === true;
  if (is_false(testResult)) {
    if (elseExpr !== undefined) {
      return yield { call: evaluate(elseExpr, ctx), tail: inTail, onResolve };
    }
    return undefined; // No else branch, return undefined
  } else {
    return yield { call: evaluate(thenExpr, ctx), tail: inTail, onResolve };
  }
}

/**
 * Handle 'begin' special form: (begin expr*)
 *
 * R7RS §3.5 tail-position propagation: the LAST expression in the body
 * inherits the parent's tail flag; earlier expressions are non-tail (their
 * values are discarded). This is the load-bearing primitive — a lambda
 * body is wrapped in begin via evalLambda, so this routing is what makes
 * `(define (loop n) (loop (- n 1)))` tail-recursive.
 */
function* evalBegin(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let result: SchemeValue = undefined;
  let node = rest;

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (is_pair(node)) {
    // Last expression keeps the begin's tail flag; earlier ones are
    // non-tail (their values are dropped, so tail dispatch wouldn't matter
    // anyway — but threading `tail:true` through would have a Scheme lambda
    // tail-replace this slot mid-body, breaking sequential semantics).
    const isLast = is_nil(node.cdr) || !is_pair(node.cdr);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
    // Mark the LAST expr's call pass-through so a tail call emerging from it
    // collapses this begin frame (the begin frame returns `result` unchanged
    // once the loop sees node.cdr is nil — pure pass-through).
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }
    node = node.cdr;
  }

  return result;
}

/**
 * Handle 'quote' special form: (quote datum)
 */
function* evalQuote(rest: SchemeValue, _ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "quote: missing argument");
  return rest.car;
}

/**
 * Handle 'quasiquote' special form: (quasiquote datum)
 * Supports unquote and unquote-splicing
 */
function* evalQuasiquote(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "quasiquote: missing argument");
  // Unquoted sub-expressions are operands to implicit list construction —
  // not tail positions. Strip tail so a `(unquote (some-lambda))` inside
  // doesn't tail-replace this slot before the surrounding structure builds.
  return yield { call: processQuasiquote(rest.car, ctx.tail ? { ...ctx, tail: false } : ctx, 1) };
}

/**
 * Process quasiquoted expression with nesting level tracking
 */
function* processQuasiquote(expr: SchemeValue, ctx: EvalContext, level: number): EvalGenerator {
  // Vectors are processed element-wise: `#(1 ,x ,@xs) builds a fresh vector with
  // unquote evaluated and unquote-splicing flattened (R7RS §4.2.8). A vector
  // can't be improper or carry a dotted-unquote tail, so this mirrors the
  // list-element loop below without the tail-threading.
  // Vector template: a boxed SchemeVector (a `#(...) literal) or, defensively, a
  // raw array. Build a fresh boxed vector so the result is a proper vector value.
  if (expr instanceof SchemeVector || Array.isArray(expr)) {
    const items = expr instanceof SchemeVector ? expr.__vector__ : expr;
    const out: SchemeValue[] = [];
    for (const item of items) {
      if (
        level === 1 &&
        is_pair(item) &&
        item.car instanceof SchemeSymbol &&
        symbol_name(item.car) === "unquote-splicing"
      ) {
        invariant(is_pair(item.cdr), "unquote-splicing: missing argument");
        let spliced = yield { call: evaluate(item.cdr.car, ctx) };
        if (is_promise(spliced)) {
          spliced = yield spliced;
        }
        if (is_pair(spliced)) {
          let n: SchemeValue = spliced;
          while (is_pair(n)) {
            out.push(n.car);
            n = n.cdr;
          }
        } else {
          invariant(is_nil(spliced), "unquote-splicing: expected list");
        }
        continue;
      }
      out.push(yield { call: processQuasiquote(item, ctx, level) });
    }
    return new SchemeVector(out);
  }

  // Atoms are returned as-is
  if (!is_pair(expr)) {
    return expr;
  }

  // At this point TypeScript knows expr is Pair
  const first = expr.car;

  // Check for unquote
  if (first instanceof SchemeSymbol && symbol_name(first) === "unquote") {
    if (level === 1) {
      // Evaluate the unquoted expression
      invariant(is_pair(expr.cdr), "unquote: missing argument");
      return yield { call: evaluate(expr.cdr.car, ctx) };
    } else {
      // Nested quasiquote - decrease level and recurse
      invariant(is_pair(expr.cdr), "unquote: missing argument");
      const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
      return new Pair(new SchemeSymbol("unquote"), new Pair(processed, nil));
    }
  }

  // Check for unquote-splicing at top level of list
  if (first instanceof SchemeSymbol && symbol_name(first) === "unquote-splicing") {
    // This shouldn't happen at top level - splicing needs context
    invariant(level > 1, "unquote-splicing: invalid context");
    invariant(is_pair(expr.cdr), "unquote-splicing: missing argument");
    const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
    return new Pair(new SchemeSymbol("unquote-splicing"), new Pair(processed, nil));
  }

  // Check for nested quasiquote
  if (first instanceof SchemeSymbol && symbol_name(first) === "quasiquote") {
    invariant(is_pair(expr.cdr), "quasiquote: missing argument");
    const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level + 1) };
    return new Pair(new SchemeSymbol("quasiquote"), new Pair(processed, nil));
  }

  // Process list elements, handling unquote-splicing
  const results: SchemeValue[] = [];
  let node: SchemeValue = expr;
  // Improper-tail unquote: the reader represents `(a . ,x)` as the proper list
  // `(a . (unquote x))`. R7RS quasiquote treats that trailing `(unquote x)` as
  // the dotted tail — `(cons a x-value)` — NOT as two more list elements
  // `unquote` and `x`. Capture it here so the fold below threads it as `tail`.
  let tail: SchemeValue = nil;

  while (is_pair(node)) {
    const item = node.car;

    // Detect the trailing dotted-unquote `(unquote <expr>)` at level 1 (only
    // when it is the WHOLE remaining node — i.e. `,x` sat in the cdr position).
    // `quasiquote`/`unquote` at the same level outside the tail keep recursing
    // as normal elements via the regular-element branch below.
    if (
      level === 1 &&
      node.car instanceof SchemeSymbol &&
      symbol_name(node.car) === "unquote" &&
      is_pair(node.cdr) &&
      is_nil(node.cdr.cdr)
    ) {
      tail = yield { call: evaluate(node.cdr.car, ctx) };
      if (is_promise(tail)) {
        tail = yield tail;
      }
      node = nil;
      break;
    }

    // Check for unquote-splicing in list
    if (
      is_pair(item) &&
      item.car instanceof SchemeSymbol &&
      symbol_name(item.car) === "unquote-splicing" &&
      level === 1
    ) {
      // Evaluate and splice
      invariant(is_pair(item.cdr), "unquote-splicing: missing argument");
      let spliced = yield { call: evaluate(item.cdr.car, ctx) };
      if (is_promise(spliced)) {
        spliced = yield spliced;
      }
      // Splice the list into results
      if (is_pair(spliced)) {
        let splicedNode: SchemeValue = spliced;
        while (is_pair(splicedNode)) {
          results.push(splicedNode.car);
          splicedNode = splicedNode.cdr;
        }
      } else {
        invariant(is_nil(spliced), "unquote-splicing: expected list");
      }
      node = node.cdr;
      continue;
    }

    // Regular element - recurse
    const processed = yield { call: processQuasiquote(item, ctx, level) };
    results.push(processed);
    node = node.cdr;
  }

  // Handle improper list tail (a non-pair atom, e.g. `(1 2 . 3)`). The
  // dotted-unquote tail `(a . ,x)` was already captured inside the loop, which
  // sets `node = nil` on capture — so this branch only fires for atom tails.
  if (!is_nil(node)) {
    tail = yield { call: processQuasiquote(node, ctx, level) };
  }

  // Build result list, threading the (possibly improper) tail through so
  // `(a . ,x)` keeps x as the final cdr rather than nil-terminating (Q9).
  // Pair.fromArray always nil-terminates, so fold manually onto `tail`.
  let result: SchemeValue = tail;
  for (let i = results.length; i--; ) {
    result = new Pair(results[i], result);
  }
  return result;
}

/**
 * Handle 'define' special form: (define name value) or (define (name . args) body)
 */
function* evalDefine(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "define: missing name");

  const first = rest.car;
  const valueRest = rest.cdr;

  // Function definition shorthand: (define (f x) body) -> (define f (lambda (x) body))
  if (is_pair(first)) {
    // Get function name and args from the pair
    const name = first.car;
    const args = first.cdr;

    invariant(name instanceof SchemeSymbol, "define: expected symbol for function name");

    // Create lambda expression
    const value = yield { call: evalLambda(new Pair(args, valueRest), ctx) };

    // Set the function's name
    if (is_lambda_function(value)) {
      value.__name__ = symbol_name(name);
    }

    ctx.env.set(name, value);
    return undefined;
  }

  // Simple definition: (define name value)
  invariant(first instanceof SchemeSymbol, "define: expected symbol");
  invariant(is_pair(valueRest), "define: missing value");

  // NOT tail position — the value must return HERE so we can bind it. If we
  // let `tail` flow through, a `(define x (some-lambda))` could tail-replace
  // this slot and skip the `ctx.env.set` below. Strip it.
  let value = yield { call: evaluate(valueRest.car, ctx.tail ? { ...ctx, tail: false } : ctx) };
  if (is_promise(value)) {
    value = yield value;
  }

  // Set name on functions for debugging
  if (is_lambda_function(value) && !value.__name__) {
    value.__name__ = symbol_name(first);
  }

  ctx.env.set(first, value);
  return undefined;
}

/**
 * Handle 'set!' special form: (set! name value)
 */
function* evalSet(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "set!: missing name");

  const name = rest.car;
  invariant(name instanceof SchemeSymbol, "set!: expected symbol");

  const valueRest = rest.cdr;
  invariant(is_pair(valueRest), "set!: missing value");

  // NOT tail position — value returns here so we can store it. Strip tail.
  let value = yield { call: evaluate(valueRest.car, ctx.tail ? { ...ctx, tail: false } : ctx) };
  if (is_promise(value)) {
    value = yield value;
  }

  // Find the environment where the variable is defined
  const ref = ctx.env.ref(symbol_name(name));
  if (ref) {
    ref.set(name, value);
  } else {
    // R7RS §5.3.1: assigning to an unbound variable is an error. `set!` must
    // NOT create a fresh binding (that is `define`'s job) — mirror the
    // unbound-variable error shape used on lookup (Environment::get).
    throw Object.assign(new Error(`Unbound variable \`${symbol_name(name).toString()}'`), {
      publicMessage: `symbol ${symbol_name(name).toString()} does not exist - look at list of available functions at tool description`,
    });
  }
  return value;
}

/**
 * Handle 'lambda' special form: (lambda args body)
 */
function* evalLambda(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "lambda: missing arguments");

  const args = rest.car;
  const body = rest.cdr;

  // Capture the environment at definition time
  const closureEnv = ctx.env;

  // Create a closure function
  const lambda: LambdaFunction = function (this: unknown, ...values: SchemeValue[]): SchemeValue {
    // Create a new environment frame
    const callEnv = closureEnv.inherit("lambda");

    // Bind arguments
    let argNode: SchemeValue = args;
    let i = 0;

    // Handle proper list of args
    while (is_pair(argNode)) {
      const argName = argNode.car;
      if (argName instanceof SchemeSymbol) {
        callEnv.set(argName, values[i]);
      }
      i++;
      argNode = argNode.cdr;
    }

    // Handle rest arg: (lambda (a b . rest) ...)
    if (argNode instanceof SchemeSymbol) {
      // Rest of args go into this symbol as a list
      callEnv.set(argNode, Pair.fromArray(values.slice(i), false));
    }

    // Pick up the dynamic call site if evaluatePair set it just before
    // invoking us; otherwise fall back to the lexical ctx's invocation.
    // See _dynamicCallSite comment near EvalContext.
    const dynamicInv = _dynamicCallSite ?? ctx.currentInvocation;
    // The body's evaluation context. Lambda bodies start in tail position
    // by R7RS §3.5: the last expression in the body is tail w.r.t. the
    // lambda's caller, so we set tail=true here and let evalBegin/evalIf/
    // etc. propagate it to the structurally-terminal expression.
    const bodyCtx: EvalContext = {
      ...ctx,
      env: callEnv,
      currentInvocation: dynamicInv,
      tail: true,
    };

    // Bounce protocol: if the calling evaluatePair flagged that it speaks
    // the protocol (`_canBounce === true`), return the body generator as a
    // Bounce token instead of spawning a fresh `run(...)` here. The outer
    // trampoline then drives the body directly — the host stack stays flat
    // across the lambda boundary, so `(define (loop) (loop)) (loop)` no
    // longer accumulates one await per recursion (which V8 caps at ~10k
    // before RangeError). See `_canBounce` for the protocol war story.
    //
    // When `_canBounce` is false the caller is JS code (HOF callback, JS
    // host entry via `exec`, etc.) that expects a SchemeValue or Promise;
    // we fall through to the original `run(...)` path so its return shape
    // is unchanged.
    if (_canBounce) {
      return makeBounce(evalBegin(body, bodyCtx)) as SchemeValue;
    }

    // Evaluate body - returns a promise that runs the generator.
    // Forward the signal: a lambda invoked inside a long-running computation
    // must honor the same abort budget as the outer `run()` call.
    return run(evalBegin(body, bodyCtx), {
      signal: ctx.signal,
    });
  };

  // Mark as lambda for identification
  lambda.__lambda__ = true;

  // Stash positional parameter names so tracers can correlate symbol uses
  // inside the body to the parameter slot they bind. Variadic-only
  // lambdas leave __params__ empty.
  const params: string[] = [];
  let walk: SchemeValue = args;
  while (is_pair(walk)) {
    const p = walk.car;
    if (p instanceof SchemeSymbol) params.push(symbol_name(p));
    walk = walk.cdr;
  }
  lambda.__params__ = params;

  return lambda;
}

/**
 * Handle 'define-macro' special form: (define-macro (name . args) body)
 */
function* evalDefineMacro(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "define-macro: missing definition");

  const first = rest.car;
  invariant(is_pair(first), "define-macro: expected (name . args)");

  const name = first.car;
  const args = first.cdr;
  invariant(name instanceof SchemeSymbol, "define-macro: expected symbol for name");

  const body = rest.cdr;

  // Create a macro function - receives unevaluated code
  const macroFn = function (this: Environment, code: SchemeValue, evalArgs: EvalContext): SchemeValue {
    const macroEnv = ctx.env.inherit("macro");

    // Bind macro parameters to unevaluated arguments
    let argNode: SchemeValue = args;
    let codeNode: SchemeValue = code;
    let i = 0;

    while (is_pair(argNode)) {
      const argName = argNode.car;
      if (argName instanceof SchemeSymbol) {
        const value = is_pair(codeNode) ? codeNode.car : nil;
        macroEnv.set(argName, value);
      }
      i++;
      argNode = argNode.cdr;
      if (is_pair(codeNode)) {
        codeNode = codeNode.cdr;
      }
    }

    // Handle rest arg
    if (argNode instanceof SchemeSymbol) {
      macroEnv.set(argNode, codeNode);
    }

    // Evaluate macro body to get expansion.
    // Forward signal so macro expansion is also budget-bounded.
    return run(evalBegin(body, { ...evalArgs, env: macroEnv }), {
      signal: evalArgs.signal,
    });
  };

  // Create and register the macro
  const macro = new Macro(symbol_name(name), macroFn);
  ctx.env.set(name, macro);

  return undefined;
}

// ============================================================================
// Core Macros (implemented as special forms for performance)
// ============================================================================

/**
 * Handle 'let' special form: (let ((var val) ...) body...)
 * Also handles named let: (let name ((var val) ...) body...)
 */
function* evalLet(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "let: missing bindings");

  let bindings: SchemeValue;
  let body: SchemeValue;
  let name: SchemeSymbol | null = null;

  // Check for named let: (let name ((var val) ...) body...)
  if (rest.car instanceof SchemeSymbol) {
    name = rest.car;
    const afterName = rest.cdr;
    invariant(is_pair(afterName), "let: missing bindings after name");
    bindings = afterName.car;
    body = afterName.cdr;
  } else {
    bindings = rest.car;
    body = rest.cdr;
  }

  // Create new environment
  const letEnv = ctx.env.inherit("let");

  // For named let, we need to create a recursive function
  if (name) {
    // Collect parameter names
    const params: SchemeSymbol[] = [];
    let bindNode: SchemeValue = bindings;
    while (is_pair(bindNode)) {
      const binding = bindNode.car;
      if (is_pair(binding) && binding.car instanceof SchemeSymbol) {
        params.push(binding.car);
      }
      bindNode = bindNode.cdr;
    }

    // Create the loop function
    //
    // WAR STORY (task #46, R7RS §3.5 TCO): until 2026-05-28 each recursive
    // `(loop ...)` call landed here, allocated a fresh loopEnv, and called
    // `run(...)` again. The inner `run()` returned a Promise the outer
    // trampoline awaited at the `is_promise(value)` branch — every recursion
    // added one pending await to the JS promise-resolution chain, and after
    // ~10k cycles V8's call-stack limit fired from inside PromiseRejectCallback.
    // The abort budget couldn't rescue it: the overflow happened INSIDE the
    // await machinery before the next TICK check could run. Concretely
    // `(let loop () (loop))` with a 50ms abort tainted the worker with an
    // unhandled RangeError; `(let loop ((i 0)) (loop (+ i 1)))` failed
    // outright in ~17ms because the call-stack limit beat the timer.
    //
    // Fix: same Bounce protocol as evalLambda. When evaluatePair (the only
    // Scheme-to-Scheme call boundary) sets `_canBounce = true` before
    // invoking us, we hand back the body generator wrapped as a Bounce
    // token. The outer trampoline drives the loop body directly, the host
    // stack stays flat across all recursions, and the existing TICK abort
    // cadence covers both bounded and infinite shapes. When `_canBounce` is
    // false (the loop function escaped into a JS HOF — e.g. `(map loop xs)`
    // somewhere), we fall back to the original `run(...)` path so HOF
    // callers still see a Promise.
    //
    // We forward `signal` in the non-bounce path so that any *bounded*
    // named-let loop honors the same abort budget as the outer `run()` call;
    // in the bounce path the body inherits the outer ctx's signal directly.
    const loopFn: LambdaFunction = function (...values: SchemeValue[]): SchemeValue {
      const loopEnv = letEnv.inherit("named-let");

      for (const [i, param] of params.entries()) {
        loopEnv.set(param, values[i]);
      }

      const dynamicInv = _dynamicCallSite ?? ctx.currentInvocation;
      const bodyCtx: EvalContext = {
        ...ctx,
        env: loopEnv,
        currentInvocation: dynamicInv,
        // Named-let body is tail w.r.t. its caller (the `(loop ...)` call
        // site). Tail flag propagates structurally to the body's last
        // expression — that's what makes `(loop (+ i 1))` actually
        // tail-dispatch into the next iteration.
        tail: true,
      };
      if (_canBounce) {
        return makeBounce(evalBegin(body, bodyCtx)) as SchemeValue;
      }
      return run(evalBegin(body, bodyCtx), {
        signal: ctx.signal,
      });
    };
    loopFn.__lambda__ = true;
    loopFn.__name__ = symbol_name(name);
    loopFn.__params__ = params.map((p) => symbol_name(p));

    letEnv.set(name, loopFn);
  }

  // Evaluate all bindings (in parallel for regular let).
  // Binding RHS expressions are non-tail (their values feed into the
  // letEnv; only the body is tail w.r.t. the let's parent).
  const values: SchemeValue[] = [];
  const names: SchemeSymbol[] = [];
  const bindingCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let bindNode: SchemeValue = bindings;
  while (is_pair(bindNode)) {
    const binding = bindNode.car;
    invariant(is_pair(binding), "let: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof SchemeSymbol, "let: expected symbol in binding");

    names.push(varName);

    const bindingCdr = binding.cdr;
    invariant(is_pair(bindingCdr), "let: missing value in binding");
    const valExpr = bindingCdr.car;

    // Evaluate in original environment (parallel semantics)
    let value = yield { call: evaluate(valExpr, bindingCtx) };
    if (is_promise(value)) {
      value = yield value;
    }
    values.push(value);

    bindNode = bindNode.cdr;
  }

  // Bind all values
  for (const [i, varName] of names.entries()) {
    letEnv.set(varName, values[i]);
  }

  // Evaluate body — inherits the let's tail flag via ctx spread; pass-through
  // (tail-collapsible) so a tail call in the body collapses this let frame.
  return yield { call: evalBegin(body, { ...ctx, env: letEnv }), tail: ctx.tail === true };
}

/**
 * Handle 'let*' special form: (let* ((var val) ...) body...)
 * Sequential binding - each binding can see previous ones
 */
function* evalLetStar(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "let*: missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // Create new environment
  const currentEnv = ctx.env.inherit("let*");

  // Evaluate bindings sequentially. Bindings are non-tail; only body is.
  let bindNode: SchemeValue = bindings;
  while (is_pair(bindNode)) {
    const binding = bindNode.car;
    invariant(is_pair(binding), "let*: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof SchemeSymbol, "let*: expected symbol in binding");

    const bindingCdr = binding.cdr;
    invariant(is_pair(bindingCdr), "let*: missing value in binding");
    const valExpr = bindingCdr.car;

    // Evaluate in current environment (sequential semantics)
    let value = yield { call: evaluate(valExpr, { ...ctx, env: currentEnv, tail: false }) };
    if (is_promise(value)) {
      value = yield value;
    }

    currentEnv.set(varName, value);
    bindNode = bindNode.cdr;
  }

  // Evaluate body — inherits let*'s tail flag; pass-through (tail-collapsible).
  return yield { call: evalBegin(body, { ...ctx, env: currentEnv }), tail: ctx.tail === true };
}

/**
 * Handle 'letrec' special form: (letrec ((var val) ...) body...)
 * Recursive binding - all bindings can see each other
 */
function* evalLetrec(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "letrec: missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // Create new environment
  const letrecEnv = ctx.env.inherit("letrec");

  // First pass: bind all names to undefined
  const bindingList: Array<{ name: SchemeSymbol; expr: SchemeValue }> = [];
  let bindNode: SchemeValue = bindings;
  while (is_pair(bindNode)) {
    const binding = bindNode.car;
    invariant(is_pair(binding), "letrec: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof SchemeSymbol, "letrec: expected symbol in binding");

    const bindingCdr = binding.cdr;
    invariant(is_pair(bindingCdr), "letrec: missing value in binding");
    const valExpr = bindingCdr.car;

    letrecEnv.set(varName, undefined);
    bindingList.push({ name: varName, expr: valExpr });
    bindNode = bindNode.cdr;
  }

  // Second pass: evaluate and assign (in the letrec environment).
  // Bindings are non-tail; only body inherits letrec's tail flag.
  for (const { name, expr } of bindingList) {
    let value = yield { call: evaluate(expr, { ...ctx, env: letrecEnv, tail: false }) };
    if (is_promise(value)) {
      value = yield value;
    }
    letrecEnv.set(name, value);
  }

  // Evaluate body — inherits letrec's tail flag; pass-through (tail-collapsible).
  return yield { call: evalBegin(body, { ...ctx, env: letrecEnv }), tail: ctx.tail === true };
}

/**
 * Handle 'and' special form: (and expr...)
 * Short-circuit evaluation - returns first false value or last value.
 *
 * R7RS §3.5 tail-position: only the LAST expression inherits the and's tail
 * flag — earlier ones short-circuit on `#f` and don't reach tail dispatch.
 */
function* evalAnd(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  // (and) with no args returns #t
  if (!is_pair(rest) || is_nil(rest)) {
    return true;
  }

  let node: SchemeValue = rest;
  let result: SchemeValue = true;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (is_pair(node)) {
    const isLast = is_nil(node.cdr) || !is_pair(node.cdr);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
    // Last expr is pass-through (its value is returned unchanged); mark tail
    // so it collapses on a tail call. The short-circuit check below only
    // matters for non-last exprs, so collapsing past it on the last is safe.
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }

    // Short-circuit on false
    if (is_false(result)) {
      return result;
    }

    node = node.cdr;
  }

  return result;
}

/**
 * Handle 'or' special form: (or expr...)
 * Short-circuit evaluation - returns first true value or last value.
 *
 * R7RS §3.5 tail-position: only the LAST expression inherits the or's tail
 * flag — earlier ones short-circuit on truthy and don't reach tail dispatch.
 */
function* evalOr(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  // (or) with no args returns #f
  if (!is_pair(rest) || is_nil(rest)) {
    return false;
  }

  let node: SchemeValue = rest;
  let result: SchemeValue = false;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (is_pair(node)) {
    const isLast = is_nil(node.cdr) || !is_pair(node.cdr);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
    // Last expr is pass-through; mark tail so it collapses on a tail call.
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }

    // Short-circuit on true (anything not false)
    if (!is_false(result)) {
      return result;
    }

    node = node.cdr;
  }

  return result;
}

/**
 * Apply an already-evaluated procedure to one already-evaluated argument,
 * routing the call through the SAME trampoline tail path `evaluatePair` uses
 * for a normal application.
 *
 * This is the `=>` arm of `cond`/`case`: R7RS §3.5 places the `(proc test-value)`
 * application in tail position when the enclosing form is in tail position. The
 * previous implementation applied `proc` via a direct synchronous JS call, which
 * routed a Scheme lambda body through the legacy `run(...)`-per-call path —
 * growing the host stack and overflowing on a self-recursive `=>` loop (the
 * "outside the TCO surface" war story). Mirroring `evaluatePair`'s bounce
 * protocol here brings `=>` onto the TCO surface: a Scheme lambda hands back a
 * Bounce, which collapses the tail tower (tail) or threads through a
 * pass-through `{ call, tail:true }` (non-tail). Non-lambda callables (builtins,
 * `SchemeJSFunction`) can't tail-recurse into Scheme, so they keep the direct
 * apply.
 *
 * Provenance: this helper does NOT stamp control-flow provenance itself. The
 * caller wraps the `{ call: applyArrowProc(...) }` yield with
 * `onResolve: controlFlowResolve(predicate)`. Because this generator's slot is
 * pass-through (`return yield`), the trampoline's tailCall collapse picks up
 * that caller-supplied `onResolve` from the popped slot and composes it onto
 * the replacement — so the predicate's lineage rides BOTH the collapsed (bounce)
 * and resumed (plain-value) paths, exactly like the non-`=>` arms.
 */
function* applyArrowProc(proc: SchemeValue, arg: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_callable(proc), "=> requires a procedure");

  // Lambdas (and named-let loop fns) speak the bounce protocol; route them
  // through the trampoline so a tail `=>` collapses instead of overflowing.
  if (is_function(proc) && (proc as LambdaFunction).__lambda__ === true) {
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = _dynamicCallSite;
    _dynamicCallSite = dynSite;
    const __savedCanBounce = _canBounce;
    _canBounce = true;
    const __savedSpeculate = _speculate;
    _speculate = ctx.speculate === true;
    const wrappedArgs = wrapLambdaArgs([arg], dynSite);
    let result: SchemeValue;
    try {
      result = (proc as LambdaFunction)(...wrappedArgs);
    } finally {
      _dynamicCallSite = __savedDynamicCallSite;
      _canBounce = __savedCanBounce;
      _speculate = __savedSpeculate;
    }

    if (is_bounce(result)) {
      if (ctx.tail) {
        // Collapse the whole tail tower (the caller's onResolve rides via the
        // popped pass-through slot — see this helper's provenance note).
        return yield { tailCall: { generator: result.generator } } as unknown as SchemeValue;
      }
      return yield { call: result.generator, tail: true };
    }
    if (is_promise(result)) {
      result = yield result;
    }
    return result;
  }

  // Builtins / SchemeJSFunction: direct apply (no Scheme body to tail into).
  let result: SchemeValue;
  if (proc instanceof SchemeJSFunction) {
    result = proc.call(arg);
  } else if (is_function(proc)) {
    result = proc(arg);
  } else {
    invariant(false, "=> requires a procedure");
  }
  if (is_promise(result)) {
    result = yield result;
  }
  return result;
}

/**
 * Handle 'cond' special form: (cond (test expr...) ... (else expr...)?)
 */
function* evalCond(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let node: SchemeValue = rest;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (is_pair(node)) {
    const clause = node.car;
    invariant(is_pair(clause), "cond: invalid clause");

    const test = clause.car;
    const exprs = clause.cdr;

    // Check for else clause. Matched-clause body inherits cond's tail flag
    // and is pass-through (tail-collapsible).
    if (test instanceof SchemeSymbol && symbol_name(test) === "else") {
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true };
    }

    // Evaluate test (non-tail — its value drives dispatch, not the result).
    let testResult = yield { call: evaluate(test, nonTailCtx) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Check for => syntax: (test => proc). Per R7RS §3.5 the `(proc testResult)`
      // application is in tail position when cond is — route it through
      // applyArrowProc so a self-recursive `=>` loop collapses on the trampoline
      // instead of overflowing the host stack. The control-flow provenance rides
      // as `onResolve` (pass-through, same as the non-`=>` arms below).
      if (is_pair(exprs)) {
        const firstExpr = exprs.car;
        if (firstExpr instanceof SchemeSymbol && symbol_name(firstExpr) === "=>") {
          const exprsCdr = exprs.cdr;
          invariant(is_pair(exprsCdr), "cond: missing procedure after =>");
          const procExpr = exprsCdr.car;
          let proc = yield { call: evaluate(procExpr, nonTailCtx) };
          if (is_promise(proc)) {
            proc = yield proc;
          }
          invariant(is_callable(proc), "cond: => requires a procedure");
          return yield {
            call: applyArrowProc(proc, testResult, ctx),
            tail: ctx.tail === true,
            onResolve: controlFlowResolve(testResult),
          };
        }
      }

      // No expressions means return test result (already carries its own provenance)
      if (!is_pair(exprs) || is_nil(exprs)) {
        return testResult;
      }

      // Evaluate expressions — pass-through (tail-collapsible). Provenance
      // restriction rides as onResolve so it fires for both the collapsed
      // (tail-call) and resumed (plain-value) paths.
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
    }

    node = node.cdr;
  }

  // No clause matched
  return undefined;
}

/**
 * Handle 'case' special form: (case key ((datum...) expr...) ... (else expr...)?)
 */
function* evalCase(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "case: missing key");

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Evaluate key (non-tail — drives dispatch, value is consumed by case).
  let key = yield { call: evaluate(rest.car, nonTailCtx) };
  if (is_promise(key)) {
    key = yield key;
  }

  let node: SchemeValue = rest.cdr;

  while (is_pair(node)) {
    const clause = node.car;
    invariant(is_pair(clause), "case: invalid clause");

    const datums = clause.car;
    const exprs = clause.cdr;

    // Check for else clause — pass-through (tail-collapsible).
    if (datums instanceof SchemeSymbol && symbol_name(datums) === "else") {
      // R7RS §6.3 also allows `(else => proc)`: apply proc to the key in tail
      // position (mirrors cond's `=>`).
      const arrowProc = yield* evalCaseArrowProc(exprs, nonTailCtx);
      if (arrowProc !== undefined) {
        return yield {
          call: applyArrowProc(arrowProc, key, ctx),
          tail: ctx.tail === true,
          onResolve: controlFlowResolve(key),
        };
      }
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true };
    }

    // Check if key matches any datum (using eqv? semantics)
    invariant(is_pair(datums), "case: expected list of datums");
    let datumNode: SchemeValue = datums;
    let matched = false;

    while (is_pair(datumNode)) {
      const datum = datumNode.car;
      // eqv? comparison
      if (key === datum || (typeof key === typeof datum && key?.valueOf?.() === datum?.valueOf?.())) {
        matched = true;
        break;
      }
      datumNode = datumNode.cdr;
    }

    if (matched) {
      // R7RS §6.3 `=>` arm: `((d1 ...) => proc)` applies proc to the key. Route
      // through applyArrowProc so a tail `=>` collapses on the trampoline.
      const arrowProc = yield* evalCaseArrowProc(exprs, nonTailCtx);
      if (arrowProc !== undefined) {
        return yield {
          call: applyArrowProc(arrowProc, key, ctx),
          tail: ctx.tail === true,
          onResolve: controlFlowResolve(key),
        };
      }
      // Pass-through (tail-collapsible). Per spec §5.3 the dispatching value
      // (the case key) plays the predicate role — its lineage was consulted
      // to pick this arm. Provenance restriction rides as onResolve so it
      // applies for both the collapsed and resumed paths.
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(key) };
    }

    node = node.cdr;
  }

  return undefined;
}

/**
 * Detect and evaluate a `case` clause's `=> proc` form. Returns the evaluated
 * procedure if `exprs` is `(=> proc)`, else `undefined` (a normal body). The
 * procedure is evaluated in non-tail context; the application itself is routed
 * through applyArrowProc by the caller so it stays on the TCO surface.
 */
function* evalCaseArrowProc(exprs: SchemeValue, nonTailCtx: EvalContext): EvalGenerator {
  if (!is_pair(exprs)) return undefined;
  const first = exprs.car;
  if (!(first instanceof SchemeSymbol) || symbol_name(first) !== "=>") return undefined;
  const exprsCdr = exprs.cdr;
  invariant(is_pair(exprsCdr), "case: missing procedure after =>");
  let proc = yield { call: evaluate(exprsCdr.car, nonTailCtx) };
  if (is_promise(proc)) {
    proc = yield proc;
  }
  invariant(is_callable(proc), "case: => requires a procedure");
  return proc;
}

/**
 * Handle 'when' special form: (when test expr...)
 * Execute expressions only if test is true
 */
function* evalWhen(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "when: missing test");

  const test = rest.car;
  const body = rest.cdr;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(test, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (!is_false(testResult)) {
    // Matched body inherits when's tail flag; pass-through (tail-collapsible),
    // provenance restriction rides as onResolve.
    return yield { call: evalBegin(body, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
  }

  return undefined;
}

/**
 * Handle 'unless' special form: (unless test expr...)
 * Execute expressions only if test is false
 */
function* evalUnless(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "unless: missing test");

  const test = rest.car;
  const body = rest.cdr;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(test, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (is_false(testResult)) {
    // Matched body inherits unless's tail flag; pass-through (tail-collapsible),
    // provenance restriction rides as onResolve.
    return yield { call: evalBegin(body, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
  }

  return undefined;
}

/**
 * Handle 'do' special form: (do ((var init step) ...) (test result...) body...)
 */
function* evalDo(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "do: missing bindings");

  const bindings = rest.car;
  const restCdr = rest.cdr;
  invariant(is_pair(restCdr), "do: missing test clause");

  const testClause = restCdr.car;
  const body = restCdr.cdr;

  invariant(is_pair(testClause), "do: invalid test clause");

  const test = testClause.car;
  const resultExprs = testClause.cdr;

  // Create environment and collect bindings
  const doEnv = ctx.env.inherit("do");
  const vars: Array<{ name: SchemeSymbol; step: SchemeValue | null }> = [];

  // do's structural tail-position: ONLY the result-expression(s) are tail.
  // Bindings, test, step, body all evaluate as side-effects/predicates and
  // are explicitly non-tail. (do itself already iterates inside ONE
  // generator's `while (true)` — recursion is flat regardless, so the
  // tail flag matters only for what the result expressions eventually do.)
  const doNonTail: EvalContext = { ...ctx, env: doEnv, tail: false };
  const doTail: EvalContext = { ...ctx, env: doEnv };

  // Initialize variables (non-tail — values feed into doEnv).
  let bindNode: SchemeValue = bindings;
  while (is_pair(bindNode)) {
    const binding = bindNode.car;
    invariant(is_pair(binding), "do: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof SchemeSymbol, "do: expected symbol");

    const bindingCdr = binding.cdr;
    let initExpr: SchemeValue = undefined;
    let stepExpr: SchemeValue | null = null;

    if (is_pair(bindingCdr)) {
      initExpr = bindingCdr.car;
      const bindingCddr = bindingCdr.cdr;
      if (is_pair(bindingCddr)) {
        stepExpr = bindingCddr.car;
      }
    }

    // Evaluate initial value
    let initValue = yield { call: evaluate(initExpr, ctx.tail ? { ...ctx, tail: false } : ctx) };
    if (is_promise(initValue)) {
      initValue = yield initValue;
    }

    doEnv.set(varName, initValue);
    vars.push({ name: varName, step: stepExpr });

    bindNode = bindNode.cdr;
  }

  // Main loop
  while (true) {
    // Test condition (non-tail — predicate for loop dispatch).
    let testResult = yield { call: evaluate(test, doNonTail) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Test is true - evaluate result expressions in tail position;
      // pass-through (tail-collapsible).
      if (is_pair(resultExprs)) {
        return yield { call: evalBegin(resultExprs, doTail), tail: ctx.tail === true };
      }
      return undefined;
    }

    // Execute body (non-tail — body's value is discarded each iteration).
    if (is_pair(body)) {
      yield { call: evalBegin(body, doNonTail) };
    }

    // Update variables
    const newValues: SchemeValue[] = [];
    for (const { step } of vars) {
      if (step === null) {
        newValues.push(undefined); // placeholder
      } else {
        let newValue = yield { call: evaluate(step, doNonTail) };
        if (is_promise(newValue)) {
          newValue = yield newValue;
        }
        newValues.push(newValue);
      }
    }

    // Apply updates
    for (const [i, { name, step }] of vars.entries()) {
      if (step !== null) {
        doEnv.set(name, newValues[i]);
      }
    }
  }
}

/**
 * Handle 'while' special form: (while test body...)
 *
 * Iterate the body while `test` evaluates truthy; returns unspecified (nil).
 * Like `do`, the whole loop runs inside ONE generator's `while (true)` so the
 * host stack stays flat no matter how many iterations execute — this is what
 * makes `while` stack-safe (the legacy Macro recursed on the JS stack).
 */
function* evalWhile(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "while: missing test");

  const test = rest.car;
  const body = rest.cdr;

  // test is a predicate; body's value is discarded each iteration — both
  // strictly non-tail (nothing here is in while's tail position).
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (true) {
    let testResult = yield { call: evaluate(test, nonTailCtx) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (is_false(testResult)) {
      return undefined;
    }

    if (is_pair(body)) {
      yield { call: evalBegin(body, nonTailCtx) };
    }
  }
}

/**
 * Handle 'try' special form: (try body (catch (var) handler...) [(finally expr...)])
 *
 * Exception handling with optional catch and finally clauses.
 * At least one of catch or finally must be present.
 */
function* evalTry(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "try: missing body");

  const body = rest.car;
  let catchClause: SchemeValue | null = null;
  let finallyClause: SchemeValue | null = null;

  // Parse clauses
  let clauseNode = rest.cdr;
  while (is_pair(clauseNode)) {
    const clause = clauseNode.car;
    if (is_pair(clause)) {
      const clauseHead = clause.car;
      if (clauseHead instanceof SchemeSymbol) {
        const name = symbol_name(clauseHead);
        if (name === "catch") {
          catchClause = clause;
        } else if (name === "finally") {
          finallyClause = clause;
        }
      }
    }
    clauseNode = clauseNode.cdr;
  }

  invariant(catchClause || finallyClause, "try: requires catch or finally clause");

  // Create a promise to handle the try/catch/finally logic
  // This is necessary because errors can come from yielded promises
  //
  // Each clause runs in its OWN fresh `run()` (nested trampoline) so the
  // outer try/catch can intercept thrown errors. That fresh-trampoline
  // boundary already isolates the host stack — but we strip `tail` so the
  // body/handlers are treated as top-of-trampoline (not tail w.r.t. the
  // surrounding form), keeping the bounce protocol from reaching across
  // the `run()` boundary in a confusing way. A tail loop INSIDE the body
  // still gets full TCO within its own trampoline.
  const bodyCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;
  const resultPromise = (async () => {
    let result: SchemeValue;
    let caughtError: Error | null = null;

    // Execute body. Forward signal so the body of a try/catch is bounded.
    try {
      result = await run(evaluate(body, bodyCtx), { signal: ctx.signal });
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
    }

    // Handle catch clause if there was an error
    if (caughtError && catchClause) {
      // (catch (var) handler...)
      const catchCdr = (catchClause as Pair).cdr;
      invariant(is_pair(catchCdr), "try: invalid catch syntax");

      const varSpec = catchCdr.car;
      invariant(is_pair(varSpec), "try: catch requires (var)");

      const varName = varSpec.car;
      invariant(varName instanceof SchemeSymbol, "try: catch variable must be a symbol");

      const handlers = catchCdr.cdr;

      // Create catch environment with error bound
      const catchEnv = ctx.env.inherit("catch");

      // Bind the error - unwrap SchemeError to get the original raised value.
      let errorValue: SchemeValue =
        caughtError instanceof SchemeError && caughtError.cause ? caughtError.cause : caughtError;
      // X3 (conformance + security): a value that reaches here as a RAW host
      // `Error` (a JS TypeError from a primitive, the wrapping SchemeError, etc.)
      // would (a) make `error-object?` return #f — non-conformant per §6.11 — and
      // (b) leak host file paths, since `.stack`/`.fileName` are OWN properties on
      // V8 Errors and the membrane's own-property fast path hands them across.
      // Re-present such errors as an R7RS error object carrying only the message
      // (no `.stack`/`.cause`/`.fileName`). Deliberately raised Scheme values —
      // already-conformant `R7RSError`s and arbitrary non-Error objects (R7RS
      // allows `(raise <any>)`) — pass through untouched.
      //
      // `R7RSError` is loaded LAZILY (dynamic import) rather than at the top of
      // this module: a static `import ... from "./bridge.js"` pulls bridge's
      // eager `set_interaction_env` into evaluator init and breaks the
      // SchemePromise circular-init ordering (bridge.ts documents that it must
      // not be imported during lips.ts init). By the time a `try` body has
      // actually thrown, every module is fully initialized, so the dynamic
      // import resolves synchronously from the registry.
      if (errorValue instanceof Error) {
        const { R7RSError } = await import("./bridge.js");
        if (!(errorValue instanceof R7RSError)) {
          errorValue = new R7RSError(errorValue.message);
        }
        // Even a freshly-minted R7RSError carries an OWN `.stack` (V8 sets it on
        // construction) plus any inherited `.cause`/`.fileName`. The membrane's
        // own-property fast path would hand those host frames to Scheme code, so
        // strip them — the message is the only datum a §6.11 handler needs.
        const errObj = errorValue as { stack?: unknown; cause?: unknown; fileName?: unknown };
        delete errObj.stack;
        delete errObj.cause;
        delete errObj.fileName;
      }
      catchEnv.set(varName, errorValue);

      try {
        // Forward signal: a catch handler running an unbounded computation
        // (e.g. a recovery loop) must respect the same budget.
        result = await run(evalBegin(handlers, { ...ctx, env: catchEnv, tail: false }), {
          signal: ctx.signal,
        });
        caughtError = null; // Error was handled
      } catch (error) {
        // Error in catch handler - propagate
        caughtError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // Handle finally clause. Forward signal — finally is allowed to be
    // bounded too; aborts in finally propagate per JS semantics where any
    // exception would (this catch swallows them, matching the old behavior).
    if (finallyClause) {
      const finallyCdr = (finallyClause as Pair).cdr;
      try {
        await run(evalBegin(finallyCdr, { ...ctx, tail: false }), { signal: ctx.signal });
      } catch {
        // Errors in finally are ignored (per JS semantics)
      }
    }

    // If error wasn't handled, re-throw
    if (caughtError) {
      throw caughtError;
    }

    return result!;
  })();

  // Yield the promise for the trampoline to await
  return yield resultPromise;
}


// ============================================================================
// Core Evaluator
// ============================================================================

/** Map of special form names to their handlers */
const SPECIAL_FORMS: Record<string, (rest: SchemeValue, ctx: EvalContext) => EvalGenerator> = {
  // Primitive special forms
  if: evalIf,
  begin: evalBegin,
  quote: evalQuote,
  quasiquote: evalQuasiquote,
  define: evalDefine,
  "define-macro": evalDefineMacro,
  "set!": evalSet,
  lambda: evalLambda,
  // Core macros (implemented as special forms for performance)
  let: evalLet,
  "let*": evalLetStar,
  letrec: evalLetrec,
  "letrec*": evalLetrec, // R7RS: letrec* evaluates bindings left-to-right (same as our letrec impl)
  and: evalAnd,
  or: evalOr,
  cond: evalCond,
  case: evalCase,
  when: evalWhen,
  unless: evalUnless,
  do: evalDo,
  while: evalWhile,
  // delay / force — OMITTED by the purity invariant; doored in bootstrap.scm
  // (removed from the special-form table so env lookup reaches the door).
  // Error handling
  // NOTE: `raise` and `error` are deliberately NOT special forms. They are
  // defined in bootstrap.ts as R7RS procedures that walk
  // *current-exception-handlers* (§6.11). Special-form dispatch precedes env
  // lookup, so shadowing them here made the entire exception tower inert
  // (with-exception-handler / guard / raise-continuable never saw the value).
  try: evalTry,
  // parameterize — OMITTED by the purity invariant; doored in bootstrap.scm.
};

/**
 * Evaluate a Scheme expression.
 *
 * This is a generator that yields:
 * - TICK for periodic event loop breathing
 * - { call: generator, frame?: StackFrame } for recursive evaluation (FLAT - no stack growth!)
 * - Promises when JS returns them (for interop)
 */
export function* evaluate(code: SchemeValue, ctx: EvalContext): EvalGenerator {
  // Periodic tick for event loop breathing
  yield TICK;

  // Null/nil evaluates to itself
  if (code === null || is_nil(code)) {
    return code;
  }

  // Symbol lookup
  if (code instanceof SchemeSymbol) {
    const value = env_get(ctx.env, code);
    ctx.tap?.onSymbolResolved?.(ctx.currentInvocation ?? null, code, value as SchemeValue);
    return value;
  }

  // Non-pair (atoms) evaluate to themselves
  if (!is_pair(code)) {
    return code;
  }

  // Tap: fire enter/exit for parsed Pairs (those carrying __location__).
  // Atoms above and macro-expansion-constructed Pairs (no location) are skipped.
  const tap = ctx.tap;
  if (tap && __location__ in code && (!ctx.nodeFilter || ctx.nodeFilter(code))) {
    const inv = tap.enter(code, ctx.currentInvocation ?? null, ctx.tail === true);
    const childCtx: EvalContext = { ...ctx, currentInvocation: inv };
    return yield {
      call: evaluatePair(code, childCtx),
      // Pass-through (`return yield {...}`) → tail-collapsible. If the
      // evaluated form tail-calls a lambda, this slot's tap.exit is composed
      // onto the replacement so it still fires when the tail chain returns
      // (lineage stays balanced — see the trampoline tailCall war story).
      tail: true,
      // Surface the tap's substituted value (if any) back through the
      // trampoline. The provenance pipeline depends on this: `tap.exit`
      // computes provenance, clones the value with `withProvenance`, and
      // returns `{ value }` so the stamped clone — not the raw result —
      // becomes what gets bound by the surrounding `define`/`let`/arg.
      onResolve: (value) => {
        const result = tap.exit(inv, { value: value as SchemeValue });
        return result && "value" in result ? result.value : undefined;
      },
      onReject: (error) => {
        tap.exit(inv, { error });
        return undefined;
      },
    };
  }

  return yield* evaluatePair(code, ctx);
}

function* evaluatePair(code: Pair, ctx: EvalContext): EvalGenerator {
  // It's a pair - function application or special form
  const first = code.car;
  const rest = code.cdr;

  // Build frame for error reporting
  const frame: StackFrame = {
    code,
    env_name: ctx.env.__name__,
    procedure: first instanceof SchemeSymbol ? symbol_name(first) : undefined,
  };

  // Tail-position context for sub-expressions of THIS call. The call head
  // (`first`) and the arguments are evaluated in NON-tail position — only
  // the final fn.apply step is the tail-relevant boundary. The special
  // forms below thread `ctx.tail` through to their structurally-terminal
  // expressions; we pass the parent's tail flag into the special handler
  // so it can do that. Arg/head evaluation strips the flag.
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Check for special forms first (before evaluation)
  if (first instanceof SchemeSymbol) {
    const name = symbol_name(first);
    const specialHandler = SPECIAL_FORMS[name];
    if (specialHandler) {
      // Pass-through dispatch — the special form's result IS this Pair's
      // result. Mark tail so a tail call emerging from the special form's
      // terminal expression collapses this frame too (the special handler
      // threads `ctx.tail` to its own structurally-terminal sub-expression).
      return yield { call: specialHandler(rest, ctx), frame, tail: true };
    }
  }

  // If first is a pair, evaluate it to get the function
  let fn: SchemeValue;
  if (is_pair(first)) {
    // FLAT: yield { call } instead of yield*
    fn = yield { call: evaluate(first, nonTailCtx), frame };
    // If fn is a promise (from JS), yield it
    if (is_promise(fn)) {
      fn = yield fn;
    }
  } else if (first instanceof SchemeSymbol) {
    fn = env_get(ctx.env, first);
    // Fire the tap here too — this is the call-head fast path that bypasses
    // `evaluate()`. Without this, tracers miss the resolved value of every
    // function name (e.g., `(my-hof xs)` never reports `my-hof`'s lambda).
    ctx.tap?.onSymbolResolved?.(ctx.currentInvocation ?? null, first, fn as SchemeValue);
  } else if (is_function(first)) {
    fn = first;
  } else {
    invariant(false, `Cannot apply ${typeof first}: ${first}`);
  }

  // Check what kind of callable we have
  if (is_function(fn) && !is_macro(fn)) {
    // Regular function - evaluate args then call
    // FLAT: yield { call } instead of yield*
    const argsResult = yield { call: evaluateArgs(rest, nonTailCtx) };
    // evaluateArgs returns SchemeValue[], narrow with Array.isArray
    invariant(Array.isArray(argsResult), "evaluateArgs must return array");
    const args = argsResult;

    // ── Force-on-unknown-boundary (Tier 2 speculative evaluation) ──────────
    // A `HalfBaked` lazy carrier reaches a builtin's JS body directly via
    // `fn.apply` below — `evaluateArgs` only awaits real thenables, and a
    // HalfBaked is not one (`is_promise` is false on it). Any operator that does
    // NOT understand the carrier must receive its settled value, so here we
    // FORCE every HalfBaked arg unless the callable opted in (`__speculate__` —
    // set on `length` and the comparison ops, which read the interval instead).
    // This is the single chokepoint the force-on-unknown-boundary contract rides
    // on. Gated on `ctx.speculate`, so default-off runs pay nothing and no
    // HalfBaked can even exist (producers are gated on the same flag).
    if (ctx.speculate && (fn as SpeculationAware).__speculate__ !== true) {
      for (let i = 0; i < args.length; i++) {
        if (is_half_baked(args[i])) {
          args[i] = yield (args[i] as HalfBaked).force();
        }
      }
    }

    // Handle continuations specially
    if (is_continuation(fn)) {
      // Continuations are invoked via their invoke method (no args per Continuation class)
      return fn.invoke();
    }

    // is_function narrowed fn to Function, so we can call apply directly.
    // Rosetta wrappers tagged with __withCtx receive ctx as their final arg.
    // Thread the dynamic call site so user lambdas invoked synchronously
    // from native JS (e.g. map/filter) pick up THIS Pair's invocation as
    // their parent rather than the lexical one captured at lambda creation.
    //
    // Two-pronged: (a) module-level holder for synchronous HOF iteration,
    // (b) per-lambda wrapper for native HOFs that recurse via promises
    // (reduce/fold/find call `unpromise().then(callback)`, which fires from
    // a microtask AFTER finally restores the holder). Each wrapped lambda
    // re-installs its dynamic site on every invocation, so iter N+1 from
    // a microtask still sees the right parent.
    //
    // _canBounce: opt fn into the bounce protocol if it's a Scheme lambda
    // (or named-let loopFn — both carry __lambda__). The lambda's JS body
    // reads this flag and returns a Bounce token instead of spawning a
    // fresh `run(...)`. Setting it true ONLY on the immediate fn.apply
    // boundary (and restoring in finally) keeps JS HOFs that subsequently
    // call back into lambdas oblivious — they see `_canBounce` false and
    // get a Promise as before. See the flag's war story.
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = _dynamicCallSite;
    _dynamicCallSite = dynSite;
    const __savedCanBounce = _canBounce;
    _canBounce = (fn as LambdaFunction).__lambda__ === true;
    const __savedSpeculate = _speculate;
    _speculate = ctx.speculate === true;
    const wrappedArgs = wrapLambdaArgs(args, dynSite);
    let result: SchemeValue;
    try {
      result = (fn as { __withCtx?: boolean }).__withCtx
        ? fn.apply(ctx.env, [...wrappedArgs, ctx])
        : fn.apply(ctx.env, wrappedArgs);
    } finally {
      _dynamicCallSite = __savedDynamicCallSite;
      _canBounce = __savedCanBounce;
      _speculate = __savedSpeculate;
    }

    // Bounce result — the callee was a Scheme lambda speaking the protocol
    // and handed back its body generator instead of running it itself.
    // Route it through the trampoline:
    //  - In tail position: yield a `tailCall` so the trampoline COLLAPSES
    //    the whole tail tower (this frame plus all enclosing pass-through
    //    frames) and the host stack stays flat across the recursion.
    //  - Otherwise: push the body as a normal sub-call, but mark it `tail`
    //    because `return yield { call }` is itself pass-through — so a tail
    //    call from INSIDE the callee's body still collapses up to (but not
    //    through) whatever non-tail consumer sits beneath THIS frame (e.g.
    //    the evaluateArgs collector when the callee is an argument). The
    //    callee's own body runs in tail context, so its terminal call
    //    collapses naturally.
    if (is_bounce(result)) {
      if (ctx.tail) {
        return yield { tailCall: { generator: result.generator, frame } } as unknown as SchemeValue;
      }
      return yield { call: result.generator, frame, tail: true };
    }

    // If result is a promise, yield it for the runner to await
    if (is_promise(result)) {
      return yield result;
    }
    return result;
  }

  // Handle Macro - invoke it and evaluate the expansion
  if (is_macro(fn)) {
    const evalArgs = {
      env: ctx.env,
      dynamic_env: ctx.dynamic_env,
      use_dynamic: ctx.use_dynamic,
      error: ctx.error,
    };

    // Invoke the macro with unevaluated code.
    // is_macro narrowed fn to Macro, so we can access invoke directly.
    //
    // THE MATCHER OFF-BY-ONE FIX (`is_syntax(fn) ? code : rest`), landed 2026-06-11.
    // syntax-rules patterns carry a keyword slot as their FIRST element, so the
    // matcher (extract_patterns) needs the FULL form (`code`). define-macro fexprs
    // want the keyword-stripped `rest`. Passing `rest` to BOTH made the keyword
    // consume the first ARG — an off-by-one that broke fixed-arity matching, arity
    // discrimination, and ellipsis (dropped element 0). Discriminating on
    // `is_syntax(fn)` gives each the form it expects. Root-cause + the now-green
    // arity cases: src/__tests__/syntax-rules-arity-offbyone.test.ts (first block).
    //
    // Why it could land now (it was held through three prior sessions):
    //   1. The cycle-safe list walker (Pair.isCircularList) shipped — un-masking no
    //      longer wedges on cyclic data (chibi 6.4 terminates).
    //   2. The PURITY PASS removed set-cdr!/vector-set!/etc — runtime cycles are
    //      unconstructable, and the chibi mutation sections this un-masks now hit a
    //      teaching purity DOOR (→ chibi EXPECTED_FAILURES, intentional).
    //   3. The map async-leak the fix also exposed is fixed (bridge.ts).
    // The 34 un-masked chibi failures were triaged: 33 = writing-method purity
    // doors + 1 = numeric-= IEEE edge, all moved to EXPECTED_FAILURES.
    //
    // STILL OPEN (separate, tracked as the vector-pattern `it.fails` block):
    // syntax-rules VECTOR patterns need a SchemeVector unwrap in matcher/expander
    // (boxing-track S9); dotted-tail-after-ellipsis template, `_`-wildcard binding,
    // let-syntax recursive hygiene — the L1 expander rework.
    let expansion = fn.invoke(is_syntax(fn) ? code : rest, evalArgs, false);

    // If macro returns a promise, yield it
    if (is_promise(expansion)) {
      expansion = yield expansion;
    }

    // Syntax returns quoted result, Macro requires evaluation of expansion
    if (is_syntax(fn)) {
      return expansion; // Syntax result is already quoted
    }

    // Regular macro - evaluate the expansion
    // Check if result is marked as data (no further evaluation needed)
    if (is_data_marked(expansion)) {
      return expansion;
    }

    // Recursively evaluate the macro expansion. The expansion takes the
    // PARENT's tail flag — a macro invocation in tail position should make
    // its expansion run in tail position too, otherwise rewriting any TCO-
    // critical form through a macro (e.g. `when` rewritten as `(if test
    // body)`) silently loses TCO at the rewrite boundary. Mark pass-through
    // (tail) so the collapse reaches through this dispatch; the post-yield
    // promise check only runs for non-tail-call results (a tail call is
    // never a JS promise), so collapsing past it is safe.
    let result = yield { call: evaluate(expansion, ctx), tail: true };
    if (is_promise(result)) {
      result = yield result;
    }
    return result;
  }

  // Handle SchemeJSFunction - wrapped JS functions from membrane
  if (fn instanceof SchemeJSFunction) {
    // Evaluate args then call via the wrapper's apply method
    const argsResult = yield { call: evaluateArgs(rest, nonTailCtx) };
    invariant(Array.isArray(argsResult), "evaluateArgs must return array");
    const args = argsResult;

    // SchemeJSFunction.apply handles toJS/fromJS boundary crossing.
    // Thread dynamic call site (see comment in regular function path above).
    // SchemeJSFunction wraps a JS function across the membrane — it's never
    // a Scheme lambda, so the bounce protocol doesn't apply here (the JS
    // function inside the membrane wouldn't know how to produce a Bounce
    // anyway). Leave _canBounce alone.
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = _dynamicCallSite;
    _dynamicCallSite = dynSite;
    const wrappedArgs = wrapLambdaArgs(args, dynSite);
    let result: SchemeValue;
    try {
      result = fn.apply(undefined, wrappedArgs);
    } finally {
      _dynamicCallSite = __savedDynamicCallSite;
    }

    // If result is a promise, yield it for the runner to await
    if (is_promise(result)) {
      return yield result;
    }
    return result;
  }

  // Handle Parameter - calling a parameter returns its value
  if (is_parameter(fn)) {
    // Parameters are called with no args to get their value
    // (my-param) -> returns the parameter's current value
    return fn.invoke();
  }

  invariant(false, `Not callable: ${typeof fn}`);
}

/**
 * Evaluate a list of arguments.
 * Uses iterative approach with flat trampolining.
 */
function* evaluateArgs(rest: SchemeValue, ctx: EvalContext): Generator<unknown, SchemeValue[], SchemeValue> {
  const args: SchemeValue[] = [];
  let node: SchemeValue = rest;

  while (is_pair(node)) {
    // TypeScript knows node is Pair after the is_pair check
    // FLAT: yield { call } instead of yield*
    let arg = yield { call: evaluate(node.car, ctx) };

    // If it's a promise, yield it
    if (is_promise(arg)) {
      arg = yield arg;
    }

    args.push(arg);
    node = node.cdr;
  }

  invariant(is_nil(node) || node === null, "Syntax Error: improper list in function call");

  return args;
}

// ============================================================================
// High-level API
// ============================================================================

/**
 * Execute Scheme code and return the result.
 * This is the main entry point.
 */
export function exec(code: SchemeValue, ctx: EvalContext): Promise<SchemeValue> {
  return run(evaluate(code, ctx), { signal: ctx.signal });
}
