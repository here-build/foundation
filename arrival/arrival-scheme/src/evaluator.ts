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
  readonly schemeStack: StackFrame[];

  constructor(message: string, schemeStack: StackFrame[], cause?: Error) {
    super(message);
    this.name = "SchemeError";
    this.schemeStack = schemeStack;
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
  if (code === nil) return "()";
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
    return result.length > maxLen ? result.slice(0, maxLen - 3) + "..." : result;
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
  exit(invocation: Invocation, result: { value: SchemeValue } | { error: unknown }): void;
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

/** Interface for functions created by lambda */
interface LambdaFunction {
  __lambda__?: boolean;
  __name__?: string;

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
  /** Fired by the trampoline when the sub-generator returns normally. */
  onResolve?: (value: unknown) => void;
  /** Fired by the trampoline when the sub-generator (or its descendants) throws. */
  onReject?: (error: unknown) => void;
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
  if (value === undefined) {
    throw new Error(`Unbound variable \`${String(name)}'`);
  }
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
 */
export async function run<T>(generator: Generator<unknown, T, unknown>): Promise<T> {
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
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemeError(message, frames, error instanceof Error ? error : undefined);
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
        // Generator finished - fire onResolve, pop, pass result to parent
        const finishedCall = callStack[callStack.length - 1];
        if (finishedCall?.onResolve) {
          try {
            finishedCall.onResolve(result.value);
          } catch {
            // Tap exceptions must not break evaluation.
          }
        }
        stack.pop();
        frameStack.pop();
        callStack.pop();
        valueToSend = result.value;
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
        // Yield every 1000 iterations or 5ms, whichever comes first
        if (iterations > 1000 || performance.now() - lastYield > 5) {
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
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemeError(message, frames, error instanceof Error ? error : undefined);
  }
}

/**
 * Synchronous runner for when we know there's no async.
 * Throws if a promise is encountered.
 * Also uses flat trampoline for stack safety.
 */
export function runSync<T>(generator: Generator<unknown, T, unknown>): T {
  const stack: Generator<unknown, unknown, unknown>[] = [generator];
  const frameStack: (StackFrame | undefined)[] = [undefined];
  let valueToSend: unknown = undefined;

  try {
    while (stack.length > 0) {
      const current = stack.at(-1)!;
      let result: IteratorResult<unknown, unknown>;

      try {
        result = current.next(valueToSend);
      } catch (error) {
        const frames = frameStack.filter((f): f is StackFrame => f !== undefined);
        if (error instanceof SchemeError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new SchemeError(message, frames, error instanceof Error ? error : undefined);
      }

      valueToSend = undefined;

      if (result.done) {
        stack.pop();
        frameStack.pop();
        valueToSend = result.value;
        continue;
      }

      const value = result.value;

      if (is_call(value)) {
        stack.push(value.call);
        frameStack.push(value.frame);
        continue;
      }

      invariant(!is_promise(value), "Unexpected promise in synchronous evaluation");

      if (value === TICK) {
        // In sync mode, just continue (no yielding)
        continue;
      }

      valueToSend = value;
    }

    return valueToSend as T;
  } catch (error) {
    if (error instanceof SchemeError) {
      throw error;
    }
    const frames = frameStack.filter((f): f is StackFrame => f !== undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemeError(message, frames, error instanceof Error ? error : undefined);
  }
}

// ============================================================================
// Special Form Handlers
// ============================================================================

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
      return yield { call: evaluate(elseExpr, ctx) };
    }
    return undefined; // No else branch, return undefined
  } else {
    return yield { call: evaluate(thenExpr, ctx) };
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
    if (level === 1) {
      // This shouldn't happen at top level - splicing needs context
      throw new Error("unquote-splicing: invalid context");
    } else {
      invariant(is_pair(expr.cdr), "unquote-splicing: missing argument");
      const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
      return new Pair(new SchemeSymbol("unquote-splicing"), new Pair(processed, nil));
    }
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
    if (is_pair(item) && item.car instanceof SchemeSymbol && symbol_name(item.car) === "unquote-splicing") {
      if (level === 1) {
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
        } else if (!is_nil(spliced)) {
          throw new Error("unquote-splicing: expected list");
        }
        node = node.cdr;
        continue;
      }
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
  if (is_lambda_function(value)) {
    if (!value.__name__) {
      value.__name__ = symbol_name(first);
    }
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

    // Evaluate body - returns a promise that runs the generator
    return run(evalBegin(body, { ...ctx, env: callEnv, currentInvocation: dynamicInv }));
  };

  // Mark as lambda for identification
  lambda.__lambda__ = true;

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

    // Evaluate macro body to get expansion
    return run(evalBegin(body, { ...evalArgs, env: macroEnv }));
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
      return run(evalBegin(body, { ...ctx, env: loopEnv, currentInvocation: dynamicInv }));
    };
    loopFn.__lambda__ = true;
    loopFn.__name__ = symbol_name(name);

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
  let currentEnv = ctx.env.inherit("let*");

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
            return yield result;
          }
          return result;
        }
      }

      // No expressions means return test result
      if (!is_pair(exprs) || is_nil(exprs)) {
        return testResult;
      }

      // Evaluate expressions
      return yield { call: evalBegin(exprs, ctx) };
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
      return yield { call: evalBegin(exprs, ctx) };
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
    return yield { call: evalBegin(body, ctx) };
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
    return yield { call: evalBegin(body, ctx) };
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

  const msgStr = typeof message === "string" ? message : String(message);
  throw new Error(msgStr);
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

  // Create a thunk that evaluates the expression when called
  const thunk = () => {
    return run(evaluate(expr, ctx));
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
      if (step !== null) {
        let newValue = yield { call: evaluate(step, { ...ctx, env: doEnv }) };
        if (is_promise(newValue)) {
          newValue = yield newValue;
        }
        newValues.push(newValue);
      } else {
        newValues.push(undefined); // placeholder
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

    // Execute body
    try {
      result = await run(evaluate(body, ctx));
    } catch (e) {
      caughtError = e instanceof Error ? e : new Error(String(e));
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
      if (caughtError instanceof SchemeError && caughtError.cause) {
        errorValue = caughtError.cause;
      } else {
        errorValue = caughtError;
      }
      catchEnv.set(varName, errorValue);

      try {
        result = await run(evalBegin(handlers, { ...ctx, env: catchEnv }));
        caughtError = null; // Error was handled
      } catch (e) {
        // Error in catch handler - propagate
        caughtError = e instanceof Error ? e : new Error(String(e));
      }
    }

    // Handle finally clause
    if (finallyClause) {
      const finallyCdr = (finallyClause as Pair).cdr;
      try {
        await run(evalBegin(finallyCdr, ctx));
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
    let paramName: string | symbol;
    if (paramExpr instanceof SchemeSymbol) {
      paramName = paramExpr.valueOf();
    } else {
      throw new Error(`parameterize: expected symbol, got ${typeof paramExpr}`);
    }

    // Look up the parameter object in dynamic_env
    const param = (ctx.dynamic_env ?? ctx.env).get(paramName, { throwError: false });
    if (!is_parameter(param)) {
      throw new Error(`Unknown parameter ${String(paramName)}`);
    }

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
    oldValues.push({ name: paramName, param: param, old: param });

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
    return env_get(ctx.env, code);
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
      onResolve: (value) => tap.exit(inv, { value: value as SchemeValue }),
      onReject: (error) => tap.exit(inv, { error }),
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
    // Thread the dynamic call site through the module-level holder so that
    // user lambdas invoked synchronously from native JS (e.g. map/filter)
    // pick up THIS Pair's invocation as their parent rather than the lexical
    // one captured at lambda creation. The save/restore handles nesting.
    const __savedDynamicCallSite = _dynamicCallSite;
    _dynamicCallSite = ctx.currentInvocation;
    let result: SchemeValue;
    try {
      result = (fn as { __withCtx?: boolean }).__withCtx
        ? fn.apply(ctx.env, [...args, ctx])
        : fn.apply(ctx.env, args);
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
    const __savedDynamicCallSite = _dynamicCallSite;
    _dynamicCallSite = ctx.currentInvocation;
    let result: SchemeValue;
    try {
      result = fn.apply(undefined, args);
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
  return run(evaluate(code, ctx));
}

/**
 * Execute Scheme code synchronously.
 * Throws if any async operations are encountered.
 */
export function execSync(code: SchemeValue, ctx: EvalContext): SchemeValue {
  return runSync(evaluate(code, ctx));
}
