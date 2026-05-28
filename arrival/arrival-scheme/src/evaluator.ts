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
import { Parameter } from "./Parameter.js";
import { SchemeJSFunction } from "./membrane.js";
import { LipsError } from "./LipsError.js";
import { SchemeSymbol } from "./LSymbol.js";
import { Macro } from "./Macro.js";
import { Pair } from "./Pair.js";
import { __location__ } from "./primitives.js";
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
export class SchemeError extends LipsError {
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
  enter(node: Pair, parent: Invocation | null): Invocation;
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

function wrapLambda(lambda: LambdaFunction, dynSite: Invocation | undefined): LambdaFunction {
  const wrapped: LambdaFunction = function (this: unknown, ...values: SchemeValue[]): SchemeValue {
    const saved = _dynamicCallSite;
    _dynamicCallSite = dynSite;
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
  __data__?: boolean;
}

/** Type guard for DataMarked objects */
function is_data_marked(o: unknown): o is DataMarked {
  if (o === null || typeof o !== "object") return false;
  if (!("__data__" in o)) return false;
  // After 'in' check, TypeScript knows o has __data__ property
  return o.__data__ === true;
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
}

function is_call(o: unknown): o is Call {
  return o !== null && typeof o === "object" && "call" in o;
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
  invariant(value !== undefined, `Unbound variable \`${String(name)}'`);
  return value;
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
  const { signal } = options;

  // Fast-fail: if the caller passed an already-aborted signal, refuse
  // before allocating the trampoline state. Mirrors fetch() semantics.
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
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
          await Promise.resolve(); // Minimal yield - just microtask
          lastYield = performance.now();
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
 * Handle 'if' special form: (if test then else?)
 */
function* evalIf(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "if: missing test expression");

  const testExpr = rest.car;
  const restAfterTest = rest.cdr;

  invariant(is_pair(restAfterTest), "if: missing then expression");

  const thenExpr = restAfterTest.car;
  const elseRest = restAfterTest.cdr;
  const elseExpr = is_pair(elseRest) ? elseRest.car : undefined;

  // Evaluate test
  let testResult = yield { call: evaluate(testExpr, ctx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  // Evaluate appropriate branch
  if (is_false(testResult)) {
    if (elseExpr !== undefined) {
      const armResult = yield { call: evaluate(elseExpr, ctx) };
      return restrictControlFlowProvenance(testResult, armResult);
    }
    return undefined; // No else branch, return undefined
  } else {
    const armResult = yield { call: evaluate(thenExpr, ctx) };
    return restrictControlFlowProvenance(testResult, armResult);
  }
}

/**
 * Handle 'begin' special form: (begin expr*)
 */
function* evalBegin(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let result: SchemeValue = undefined;
  let node = rest;

  while (is_pair(node)) {
    result = yield { call: evaluate(node.car, ctx) };
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
  return yield { call: processQuasiquote(rest.car, ctx, 1) };
}

/**
 * Process quasiquoted expression with nesting level tracking
 */
function* processQuasiquote(expr: SchemeValue, ctx: EvalContext, level: number): EvalGenerator {
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

  while (is_pair(node)) {
    const item = node.car;

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

  // Handle improper list tail
  let tail: SchemeValue = nil;
  if (!is_nil(node)) {
    tail = yield { call: processQuasiquote(node, ctx, level) };
  }

  // Build result list - Pair.fromArray returns Pair or nil
  const result = Pair.fromArray(results, false);
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
    const body = valueRest;
    const value = yield { call: evalLambda(new Pair(args, body), ctx) };

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

  let value = yield { call: evaluate(valueRest.car, ctx) };
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

  let value = yield { call: evaluate(valueRest.car, ctx) };
  if (is_promise(value)) {
    value = yield value;
  }

  // Find the environment where the variable is defined
  const ref = ctx.env.ref(symbol_name(name));
  if (ref) {
    ref.set(name, value);
  } else {
    // Variable not found - set in current env (or throw?)
    ctx.env.set(name, value);
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

    // Evaluate body - returns a promise that runs the generator.
    // Forward the signal: a lambda invoked inside a long-running computation
    // must honor the same abort budget as the outer `run()` call.
    return run(evalBegin(body, { ...ctx, env: callEnv, currentInvocation: dynamicInv }), {
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
    const loopFn: LambdaFunction = function (...values: SchemeValue[]): SchemeValue {
      const loopEnv = letEnv.inherit("named-let");

      for (const [i, param] of params.entries()) {
        loopEnv.set(param, values[i]);
      }

      const dynamicInv = _dynamicCallSite ?? ctx.currentInvocation;
      // Forward signal — a named-let loop is the canonical infinite-loop
      // shape `(let loop () (loop))`, so the budget must propagate here or
      // the abort would only fire at the top-level run() boundary.
      return run(evalBegin(body, { ...ctx, env: loopEnv, currentInvocation: dynamicInv }), {
        signal: ctx.signal,
      });
    };
    loopFn.__lambda__ = true;
    loopFn.__name__ = symbol_name(name);
    loopFn.__params__ = params.map((p) => symbol_name(p));

    letEnv.set(name, loopFn);
  }

  // Evaluate all bindings (in parallel for regular let)
  const values: SchemeValue[] = [];
  const names: SchemeSymbol[] = [];

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
    let value = yield { call: evaluate(valExpr, ctx) };
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

  // Evaluate body
  return yield { call: evalBegin(body, { ...ctx, env: letEnv }) };
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

  // Evaluate bindings sequentially
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
    let value = yield { call: evaluate(valExpr, { ...ctx, env: currentEnv }) };
    if (is_promise(value)) {
      value = yield value;
    }

    currentEnv.set(varName, value);
    bindNode = bindNode.cdr;
  }

  // Evaluate body
  return yield { call: evalBegin(body, { ...ctx, env: currentEnv }) };
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

  // Second pass: evaluate and assign (in the letrec environment)
  for (const { name, expr } of bindingList) {
    let value = yield { call: evaluate(expr, { ...ctx, env: letrecEnv }) };
    if (is_promise(value)) {
      value = yield value;
    }
    letrecEnv.set(name, value);
  }

  // Evaluate body
  return yield { call: evalBegin(body, { ...ctx, env: letrecEnv }) };
}

/**
 * Handle 'and' special form: (and expr...)
 * Short-circuit evaluation - returns first false value or last value
 */
function* evalAnd(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  // (and) with no args returns #t
  if (!is_pair(rest) || is_nil(rest)) {
    return true;
  }

  let node: SchemeValue = rest;
  let result: SchemeValue = true;

  while (is_pair(node)) {
    result = yield { call: evaluate(node.car, ctx) };
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
 * Short-circuit evaluation - returns first true value or last value
 */
function* evalOr(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  // (or) with no args returns #f
  if (!is_pair(rest) || is_nil(rest)) {
    return false;
  }

  let node: SchemeValue = rest;
  let result: SchemeValue = false;

  while (is_pair(node)) {
    result = yield { call: evaluate(node.car, ctx) };
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
 * Handle 'cond' special form: (cond (test expr...) ... (else expr...)?)
 */
function* evalCond(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let node: SchemeValue = rest;

  while (is_pair(node)) {
    const clause = node.car;
    invariant(is_pair(clause), "cond: invalid clause");

    const test = clause.car;
    const exprs = clause.cdr;

    // Check for else clause
    if (test instanceof SchemeSymbol && symbol_name(test) === "else") {
      return yield { call: evalBegin(exprs, ctx) };
    }

    // Evaluate test
    let testResult = yield { call: evaluate(test, ctx) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Check for => syntax: (test => proc)
      if (is_pair(exprs)) {
        const firstExpr = exprs.car;
        if (firstExpr instanceof SchemeSymbol && symbol_name(firstExpr) === "=>") {
          const exprsCdr = exprs.cdr;
          invariant(is_pair(exprsCdr), "cond: missing procedure after =>");
          const procExpr = exprsCdr.car;
          let proc = yield { call: evaluate(procExpr, ctx) };
          if (is_promise(proc)) {
            proc = yield proc;
          }
          invariant(is_callable(proc), "cond: => requires a procedure");
          let result: SchemeValue;
          if (proc instanceof SchemeJSFunction) {
            result = proc.call(testResult);
          } else if (is_function(proc)) {
            result = proc(testResult);
          } else {
            invariant(false, "cond: => requires a procedure");
          }
          if (is_promise(result)) {
            result = yield result;
          }
          return restrictControlFlowProvenance(testResult, result);
        }
      }

      // No expressions means return test result (already carries its own provenance)
      if (!is_pair(exprs) || is_nil(exprs)) {
        return testResult;
      }

      // Evaluate expressions
      const armResult = yield { call: evalBegin(exprs, ctx) };
      return restrictControlFlowProvenance(testResult, armResult);
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

  // Evaluate key
  let key = yield { call: evaluate(rest.car, ctx) };
  if (is_promise(key)) {
    key = yield key;
  }

  let node: SchemeValue = rest.cdr;

  while (is_pair(node)) {
    const clause = node.car;
    invariant(is_pair(clause), "case: invalid clause");

    const datums = clause.car;
    const exprs = clause.cdr;

    // Check for else clause
    if (datums instanceof SchemeSymbol && symbol_name(datums) === "else") {
      return yield { call: evalBegin(exprs, ctx) };
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
      const armResult = yield { call: evalBegin(exprs, ctx) };
      // Per spec §5.3 the dispatching value (the case key) plays the predicate
      // role here — that's the one runtime value whose lineage was consulted
      // to pick this arm. The literal datums are source constants with no
      // provenance to propagate.
      return restrictControlFlowProvenance(key, armResult);
    }

    node = node.cdr;
  }

  return undefined;
}

/**
 * Handle 'when' special form: (when test expr...)
 * Execute expressions only if test is true
 */
function* evalWhen(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "when: missing test");

  const test = rest.car;
  const body = rest.cdr;

  let testResult = yield { call: evaluate(test, ctx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (!is_false(testResult)) {
    const armResult = yield { call: evalBegin(body, ctx) };
    return restrictControlFlowProvenance(testResult, armResult);
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

  let testResult = yield { call: evaluate(test, ctx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (is_false(testResult)) {
    const armResult = yield { call: evalBegin(body, ctx) };
    return restrictControlFlowProvenance(testResult, armResult);
  }

  return undefined;
}

/**
 * Handle 'raise' special form: (raise message)
 * Raises a user error with the given message.
 */
function* evalRaise(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "raise: missing message");

  let message = yield { call: evaluate(rest.car, ctx) };
  if (is_promise(message)) {
    message = yield message;
  }

  throw new Error(typeof message === "string" ? message : String(message));
}

/**
 * Handle 'error' special form: (error who message . irritants)
 * R6RS-style error with who, message, and optional irritants.
 */
function* evalError(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "error: missing who");

  let who = yield { call: evaluate(rest.car, ctx) };
  if (is_promise(who)) {
    who = yield who;
  }

  const restAfterWho = rest.cdr;
  invariant(is_pair(restAfterWho), "error: missing message");

  let message = yield { call: evaluate(restAfterWho.car, ctx) };
  if (is_promise(message)) {
    message = yield message;
  }

  const whoStr = who === false ? "" : `${who}: `;
  const msgStr = typeof message === "string" ? message : String(message);

  throw new Error(`${whoStr}${msgStr}`);
}

/**
 * Handle 'delay' special form: (delay expr)
 * Creates a promise that will evaluate expr when forced.
 */
function* evalDelay(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "delay: missing expression");

  const expr = rest.car;

  // Create a thunk that evaluates the expression when called.
  // Forward signal so a delayed/forced computation honors the budget at
  // force time (the signal captured here is the one alive when the delay
  // was created — same as ctx capture for env/dynamic_env).
  const thunk = () => {
    return run(evaluate(expr, ctx), { signal: ctx.signal });
  };

  return new SchemePromise(thunk);
}

/**
 * Handle 'force' special form: (force promise)
 * Forces evaluation of a delayed promise.
 */
function* evalForce(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "force: missing argument");

  let promise = yield { call: evaluate(rest.car, ctx) };
  if (is_promise(promise)) {
    promise = yield promise;
  }

  if (is_scheme_promise(promise)) {
    const result = promise.force();
    // If the thunk returned a JS promise, await it
    if (is_promise(result)) {
      return yield result;
    }
    return result;
  }

  // If it's not a Scheme promise, just return it
  return promise;
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

  // Initialize variables
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
    let initValue = yield { call: evaluate(initExpr, ctx) };
    if (is_promise(initValue)) {
      initValue = yield initValue;
    }

    doEnv.set(varName, initValue);
    vars.push({ name: varName, step: stepExpr });

    bindNode = bindNode.cdr;
  }

  // Main loop
  while (true) {
    // Test condition
    let testResult = yield { call: evaluate(test, { ...ctx, env: doEnv }) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Test is true - evaluate result expressions and return
      if (is_pair(resultExprs)) {
        return yield { call: evalBegin(resultExprs, { ...ctx, env: doEnv }) };
      }
      return undefined;
    }

    // Execute body
    if (is_pair(body)) {
      yield { call: evalBegin(body, { ...ctx, env: doEnv }) };
    }

    // Update variables
    const newValues: SchemeValue[] = [];
    for (const { step } of vars) {
      if (step === null) {
        newValues.push(undefined); // placeholder
      } else {
        let newValue = yield { call: evaluate(step, { ...ctx, env: doEnv }) };
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
  const resultPromise = (async () => {
    let result: SchemeValue;
    let caughtError: Error | null = null;

    // Execute body. Forward signal so the body of a try/catch is bounded.
    try {
      result = await run(evaluate(body, ctx), { signal: ctx.signal });
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

      // Bind the error - unwrap SchemeError to get the original message/error
      let errorValue: SchemeValue;
      errorValue = caughtError instanceof SchemeError && caughtError.cause ? caughtError.cause : caughtError;
      catchEnv.set(varName, errorValue);

      try {
        // Forward signal: a catch handler running an unbounded computation
        // (e.g. a recovery loop) must respect the same budget.
        result = await run(evalBegin(handlers, { ...ctx, env: catchEnv }), {
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
        await run(evalBegin(finallyCdr, ctx), { signal: ctx.signal });
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

/**
 * Handle 'parameterize' special form: (parameterize ((param val) ...) body...)
 *
 * Dynamically rebinds parameters for the duration of body evaluation.
 * Parameters are looked up in dynamic_env.
 */
function* evalParameterize(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_pair(rest), "parameterize: missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // Create environment for parameterized values
  const dynamicEnv = (ctx.dynamic_env ?? ctx.env).inherit("parameterize");

  // Process bindings: ((param val) ...)
  const oldValues: Array<{ name: string | symbol; param: Parameter; old: Parameter }> = [];

  let bindNode: SchemeValue = bindings;
  while (is_pair(bindNode)) {
    const binding = bindNode.car;
    invariant(is_pair(binding), "parameterize: invalid binding");

    const paramExpr = binding.car;

    // Get parameter name
    invariant(paramExpr instanceof SchemeSymbol, `parameterize: expected symbol, got ${typeof paramExpr}`);
    const paramName: string | symbol = paramExpr.valueOf();

    // Look up the parameter object in dynamic_env
    const param = (ctx.dynamic_env ?? ctx.env).get(paramName, { throwError: false });
    invariant(is_parameter(param), `Unknown parameter ${String(paramName)}`);

    // Evaluate the value expression
    const bindingCdr = (binding as Pair).cdr;
    invariant(is_pair(bindingCdr), "parameterize: missing value");

    let value = yield { call: evaluate(bindingCdr.car, ctx) };
    if (is_promise(value)) {
      value = yield value;
    }

    // Create inherited parameter with new value
    const newParam = param.inherit(value);
    dynamicEnv.set(paramName, newParam);

    // Track for restoration (though with our model, we don't need to restore
    // since we use a new env frame)
    oldValues.push({ name: paramName, param, old: param });

    bindNode = bindNode.cdr;
  }

  // Evaluate body with new dynamic environment
  return yield { call: evalBegin(body, { ...ctx, dynamic_env: dynamicEnv }) };
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
  // Lazy evaluation
  delay: evalDelay,
  force: evalForce,
  // Error handling
  raise: evalRaise,
  error: evalError,
  try: evalTry,
  // Dynamic parameters
  parameterize: evalParameterize,
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
    const inv = tap.enter(code, ctx.currentInvocation ?? null);
    const childCtx: EvalContext = { ...ctx, currentInvocation: inv };
    return yield {
      call: evaluatePair(code, childCtx),
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

  // Check for special forms first (before evaluation)
  if (first instanceof SchemeSymbol) {
    const name = symbol_name(first);
    const specialHandler = SPECIAL_FORMS[name];
    if (specialHandler) {
      return yield { call: specialHandler(rest, ctx), frame };
    }
  }

  // If first is a pair, evaluate it to get the function
  let fn: SchemeValue;
  if (is_pair(first)) {
    // FLAT: yield { call } instead of yield*
    fn = yield { call: evaluate(first, ctx), frame };
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
    const argsResult = yield { call: evaluateArgs(rest, ctx) };
    // evaluateArgs returns SchemeValue[], narrow with Array.isArray
    invariant(Array.isArray(argsResult), "evaluateArgs must return array");
    const args = argsResult;

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
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = _dynamicCallSite;
    _dynamicCallSite = dynSite;
    const wrappedArgs = wrapLambdaArgs(args, dynSite);
    let result: SchemeValue;
    try {
      result = (fn as { __withCtx?: boolean }).__withCtx
        ? fn.apply(ctx.env, [...wrappedArgs, ctx])
        : fn.apply(ctx.env, wrappedArgs);
    } finally {
      _dynamicCallSite = __savedDynamicCallSite;
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

    // Invoke the macro with unevaluated code
    // is_macro narrowed fn to Macro, so we can access invoke directly
    let expansion = fn.invoke(rest, evalArgs, false);

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

    // Recursively evaluate the macro expansion
    let result = yield { call: evaluate(expansion, ctx) };
    if (is_promise(result)) {
      result = yield result;
    }
    return result;
  }

  // Handle SchemeJSFunction - wrapped JS functions from membrane
  if (fn instanceof SchemeJSFunction) {
    // Evaluate args then call via the wrapper's apply method
    const argsResult = yield { call: evaluateArgs(rest, ctx) };
    invariant(Array.isArray(argsResult), "evaluateArgs must return array");
    const args = argsResult;

    // SchemeJSFunction.apply handles toJS/fromJS boundary crossing.
    // Thread dynamic call site (see comment in regular function path above).
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
