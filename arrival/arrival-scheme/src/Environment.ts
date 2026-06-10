// -------------------------------------------------------------------------
// :: Environment class - Scheme environment for variable bindings
// -------------------------------------------------------------------------
import type { EnvironmentModule, FallbackResolver } from "./bindings.js";
import type { EOF } from "./EOF.js";
import { is_env } from "./guards.js";
import type {
  doc as DocFn,
  get as GetFn,
  get_props as GetPropsFn,
  parse as ParseFn,
  patch_value as PatchValueFn,
  unbind as UnbindFn,
} from "./stdlib.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import type { Macro } from "./Macro.js";
import { createPureSchemeModule } from "./modules/pure-scheme.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import type { SchemeValue } from "./types.js";
import { SchemeCharacter, nil } from "./types.js";
import type { RosettaFunction } from "./rosetta.js";
import { createRosettaWrapper } from "./rosetta.js";
import { trim_lines } from "./utils/trim_lines.js";
import { typecheck } from "./utils/typecheck.js";
import type { Syntax } from "./Syntax.js";
import type { QuotedPromise } from "./QuotedPromise.js";
import invariant from "tiny-invariant";
import { fromJS, isSchemeValue, NOT_FOUND, SandboxViolationError, sandboxedAccess, SchemeJSFunction, SchemeJSObject } from "./membrane.js";

/**
 * Brand on a keyword-accessor pluck function carrying its bare field name
 * (`:tagline` → "tagline"). Lets consumers detect a keyword key EXPLICITLY via
 * this symbol instead of sniffing valueOf/string shape. Registered (Symbol.for)
 * so it matches across the package boundary — arrival-chain's `dict` reads the
 * same key (project.ts).
 */
export const KEYWORD_ACCESSOR_FIELD = Symbol.for("@here.build/arrival-scheme/keyword-accessor-field");

// -------------------------------------------------------------------------
// :: Runtime dependencies - deferred loading to break circular dependency
// :: These functions are only called at runtime, never during module init.
// :: We defer the actual import until first use.
// -------------------------------------------------------------------------

// Type imports are fine - they're erased at runtime

// -------------------------------------------------------------------------
// :: Type definitions for Environment bindings
// -------------------------------------------------------------------------

/**
 * A name that can be used to look up values in an environment.
 * Supports strings, symbols (both primitive and SchemeSymbol), and SchemeString.
 */
export type BindingName = string | symbol | SchemeSymbol | SchemeString;

/**
 * A function with optional LIPS metadata.
 */
export interface LipsFunction extends Function {
  __doc__?: string;
  __name__?: string | symbol;
  __code__?: unknown;
}

/**
 * Value that can be stored in an environment.
 * This includes all SchemeValues plus runtime-specific types like Macro, Syntax, etc.
 */
export type EnvironmentValue = SchemeValue | LipsFunction | Macro | Syntax | QuotedPromise | EOF | Environment | RegExp;

// Runtime module cache - populated on first access
let _lips: {
  doc: typeof DocFn;
  get_props: typeof GetPropsFn;
  patch_value: typeof PatchValueFn;
  get: typeof GetFn;
  unbind: typeof UnbindFn;
  parse: typeof ParseFn;
  global_env: Environment;
} | null = null;

// Setter function to allow lips.ts to register itself
export function setLipsRuntime(runtime: typeof _lips) {
  _lips = runtime;
}

function getLipsRuntime() {
  invariant(
    _lips,
    `lips runtime not yet loaded. This usually means a method was called during module initialization before circular dependencies resolved. Make sure to import from the main entry point (index.ts) before using Environment.`,
  );
  return _lips!;
}

// Wrapper functions that defer to lips runtime
function doc(...args: Parameters<typeof DocFn>): ReturnType<typeof DocFn> {
  return getLipsRuntime().doc(...args);
}
function get_props(obj: object): (string | symbol)[] {
  return getLipsRuntime().get_props(obj);
}
function patch_value(value: unknown, context: unknown): EnvironmentValue {
  return getLipsRuntime().patch_value(value, context) as EnvironmentValue;
}
function get(obj: unknown, ...keys: unknown[]): EnvironmentValue {
  return getLipsRuntime().get(obj, ...keys) as EnvironmentValue;
}
function unbind(obj: unknown): unknown {
  return getLipsRuntime().unbind(obj);
}
function getGlobalEnv(): Environment {
  return getLipsRuntime().global_env;
}

// -------------------------------------------------------------------------
export class Environment {
  static __class__ = "environment";
  /**
   * Options for creating environments from modules.
   */
  static readonly fromModulesDefaults = {
    /** Whether to auto-load pure scheme as the base module. Default: true */
    autoLoadPureScheme: true,
  };
  __docs__: Map<string | symbol, string> = new Map();
  __resolvers__: FallbackResolver[] = [];
  /**
   * Harvest surface for the type-lens: the TS signature string each rosetta was
   * registered with (`defineRosetta(name, { type })`). Inert at runtime; read only
   * by `arrival-chain`'s rosetta-type harvester to assemble the `ArrShape` leaf.
   * Keyed by the registered name; populated on each `defineRosetta` that carries a
   * `type`. Local to the env the rosetta was defined on (not chained).
   */
  __rosettaTypes__: Map<string, string> = new Map();

  // -------------------------------------------------------------------------
  // :: Fallback Resolver Management
  // -------------------------------------------------------------------------

  constructor(
    public __name__: string = "anonymous",
    public __env__: Record<string | symbol, EnvironmentValue> = {},
    public __parent__: Environment | null = null,
  ) {}

  /**
   * Create an environment from composable modules.
   *
   * Each module becomes a layer in the environment chain:
   * - First module is the base (parent: null)
   * - Last module is the top (where user code runs)
   *
   * By default, the pure Scheme module is auto-loaded as the base,
   * providing core primitives (cons, car, cdr, +, -, etc.).
   *
   * Resolution order per module:
   * 1. Direct bindings
   * 2. Resolvers (yield on undefined)
   * 3. Parent module (recursive)
   *
   * @param modules - Modules to compose (first = base, last = top)
   * @param execOrOptions - Either exec function or options object
   * @param exec - Optional function to evaluate bootstrap Scheme code
   * @returns The topmost environment
   *
   * @example
   * ```typescript
   * // Full environment with auto-loaded pure Scheme
   * const env = Environment.fromModules([myModule]);
   *
   * // Sandbox without auto-load (for testing or custom setups)
   * const sandbox = Environment.fromModules([myModule], { autoLoadPureScheme: false });
   * ```
   */
  static fromModules(
    modules: EnvironmentModule[],
    execOrOptions?: ((code: string, env: Environment) => void) | { autoLoadPureScheme?: boolean },
    exec?: (code: string, env: Environment) => void,
  ): Environment {
    // Parse arguments - support both (modules, exec) and (modules, options, exec)
    let options = { ...Environment.fromModulesDefaults };
    let execFn: ((code: string, env: Environment) => void) | undefined = exec;

    if (typeof execOrOptions === "function") {
      execFn = execOrOptions;
    } else if (execOrOptions) {
      options = { ...options, ...execOrOptions };
    }

    // Auto-load pure scheme as base if enabled
    let allModules = modules;
    if (options.autoLoadPureScheme) {
      // Check if pure-scheme is already in the modules list
      const hasPureScheme = modules.some((m) => m.id === "pure-scheme");
      if (!hasPureScheme) {
        try {
          // Get pure scheme bindings from global_env
          const globalEnv = getGlobalEnv();
          const pureSchemeModule = createPureSchemeModule(globalEnv);
          allModules = [pureSchemeModule, ...modules];
        } catch {
          // If lips runtime isn't loaded yet, skip auto-load silently.
          // This allows tests to run without full runtime initialization.
        }
      }
    }

    // Build dependency graph and topologically sort
    const moduleMap = new Map<string, EnvironmentModule>();
    for (const mod of allModules) {
      moduleMap.set(mod.id, mod);
    }

    // Topological sort with cycle detection
    const sorted: EnvironmentModule[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(mod: EnvironmentModule) {
      if (visited.has(mod.id)) return;
      invariant(!visiting.has(mod.id), `Circular dependency detected: ${mod.id}`);
      visiting.add(mod.id);

      // Visit dependencies first
      for (const depId of mod.dependencies ?? []) {
        const dep = moduleMap.get(depId);
        invariant(dep, `Module '${mod.id}' depends on unknown module '${depId}'`);
        visit(dep);
      }

      visiting.delete(mod.id);
      visited.add(mod.id);
      sorted.push(mod);
    }

    // Visit all modules (including auto-loaded pure-scheme if any)
    for (const mod of allModules) {
      visit(mod);
    }

    // Build environment chain
    let env: Environment | null = null;

    for (const mod of sorted) {
      // Create child environment with this module's bindings
      env = new Environment(mod.id, mod.bindings ?? {}, env);

      // Register resolver if present
      if (mod.resolver) {
        env.registerResolver(mod.resolver);
      }

      // Run bootstrap code if present and exec is provided
      if (mod.bootstrap && execFn) {
        execFn(mod.bootstrap, env);
      }
    }

    invariant(env, "No modules provided");

    return env;
  }

  /**
   * Register a fallback resolver.
   * Resolvers are tried in order when normal lookup fails.
   */
  registerResolver(resolver: FallbackResolver): this {
    // Prevent duplicate registration
    if (!this.__resolvers__.some((r) => r.id === resolver.id)) {
      this.__resolvers__.push(resolver);
    }
    return this;
  }

  /**
   * Unregister a fallback resolver by ID.
   */
  unregisterResolver(id: string): this {
    this.__resolvers__ = this.__resolvers__.filter((r) => r.id !== id);
    return this;
  }

  defineRosetta(name: string, config: RosettaFunction): void {
    const wrapper = createRosettaWrapper(config);
    this.set(name, wrapper);
    if (config.type !== undefined) this.__rosettaTypes__.set(name, config.type);
  }

  list(): (string | symbol)[] {
    return get_props(this.__env__);
  }

  fs(): EnvironmentValue {
    return this.get("**fs**");
  }

  unset(name: BindingName): void {
    let key: string | symbol;
    if (name instanceof SchemeSymbol) {
      key = name.valueOf();
    } else if (name instanceof SchemeString) {
      key = name.valueOf();
    } else {
      key = name;
    }
    delete this.__env__[key as string];
  }

  inherit(
    name: string = `child of ${this.__name__ || "unknown"}`,
    obj: Record<string, EnvironmentValue> = {},
  ): Environment {
    return new Environment(name, obj, this);
  }

  doc(name: BindingName, value: string | null = null, dump: boolean = false): this | string | undefined {
    let key: string | symbol;
    if (name instanceof SchemeSymbol) {
      key = name.__name__;
    } else if (name instanceof SchemeString) {
      key = name.valueOf();
    } else {
      key = name;
    }
    if (value) {
      const finalValue = dump ? value : trim_lines(value);
      this.__docs__.set(key, finalValue);
      return this;
    }
    if (this.__docs__.has(key)) {
      return this.__docs__.get(key);
    }
    if (this.__parent__) {
      return this.__parent__.doc(name) as string | undefined;
    }
  }

  new_frame(fn: EnvironmentValue, args: EnvironmentValue[] & { callee?: EnvironmentValue }): Environment {
    const frame = this.inherit("__frame__");
    frame.set(
      "parent.frame",
      doc("parent.frame", function (n: { valueOf(): number } = { valueOf: () => 1 }) {
        const nVal = n.valueOf();
        const scope = frame.__parent__;
        if (!is_env(scope)) {
          return nil;
        }
        if (nVal <= 0) {
          return scope;
        }
        const parent_frame = scope.get("parent.frame") as Function;
        return parent_frame(nVal - 1);
      }),
    );
    args.callee = fn;
    frame.set("arguments", args as unknown as EnvironmentValue);
    return frame;
  }

  /**
   * Per-module lookup with proper resolution order:
   * 1. This environment's direct bindings
   * 2. This environment's resolvers (yield on undefined)
   * 3. Parent environment's _lookupWithResolvers (recursive)
   *
   * This ensures each module (environment layer) has its bindings
   * checked before its resolvers, and both are checked before
   * yielding to the parent module.
   *
   * @param name - The symbol name to look up (string or symbol)
   * @returns The resolved value, or undefined if not found
   */
  _lookupWithResolvers(name: string | symbol): EnvironmentValue | undefined {
    // 1. Try this environment's direct bindings first
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    // 2. Try this environment's resolvers (in registration order)
    for (const resolver of this.__resolvers__) {
      const result = resolver.resolve(String(name), this);
      if (result !== undefined) {
        return result as EnvironmentValue;
      }
    }

    // 3. Yield to parent module
    return this.__parent__?._lookupWithResolvers(name);
  }

  toString(): string {
    return `#<environment:${this.__name__}>`;
  }

  clone(): Environment {
    // Duplicate refs while faithfully preserving BOTH:
    //   - symbol-keyed bindings (Object.keys drops them — Reflect.ownKeys does not),
    //   - the read-only attribute installed by `constant()` (a non-writable property
    //     descriptor — a plain `env[key] = …` would silently re-create the slot writable).
    // OracleSession.clone() relies on this snapshot being lossless: a clone that
    // dropped symbol keys or stripped constancy would yield a too-narrow valid-symbol
    // set and let writes land on slots that must stay constant.
    const env: Record<string | symbol, EnvironmentValue> = {};
    for (const key of Reflect.ownKeys(this.__env__)) {
      const descriptor = Object.getOwnPropertyDescriptor(this.__env__, key);
      if (descriptor) {
        Object.defineProperty(env, key, descriptor);
      }
    }
    return new Environment(this.__name__, env, this.__parent__);
  }

  merge(env: Environment, name: string = "merge"): Environment {
    typecheck("Environment::merge", env, "environment");
    return this.inherit(name, env.__env__);
  }

  get(symbol: BindingName, options: { throwError?: boolean } = {}): EnvironmentValue {
    // Clojure/Common Lisp style keyword accessors (e.g., :name)
    // These are handled specially to create property accessor functions
    if (symbol instanceof SchemeSymbol && (symbol.__name__ as string)?.startsWith?.(":")) {
      const key = (symbol.__name__ as string).replace(":", "");
      const keyPluck = Object.assign(
        (obj: unknown) => {
          if (!obj) {
            return keyPluck;
          }
          // SchemeJSObject routes through `.get` so the cached, provenance-
          // stamped entry surfaces. Same dispatch point as `(@ obj :k)` —
          // `(eq? (:k obj) (@ obj :k))` holds because the wrapper's cache
          // returns the same AValue instance for the same key.
          if (obj instanceof SchemeJSObject) return obj.get(key);
          // Scheme value types never expose their host internals via plucking.
          if (
            obj instanceof SchemeSymbol ||
            obj instanceof SchemeString ||
            obj instanceof SchemeCharacter ||
            obj instanceof Environment ||
            obj instanceof SchemeExact ||
            obj instanceof SchemeInexact
          ) {
            return nil;
          }
          // Any other raw value (plain object, function, primitive): route through
          // the SAME isolation as `(@ obj :k)` / SchemeJSObject.get — blocked
          // names (constructor, __proto__, prototype, …) and boundary-crossing
          // inherited props collapse to nil. Without this, `(:constructor f)` on
          // a lambda hands back the Function constructor → RCE.
          try {
            const raw = sandboxedAccess(obj, key);
            return raw === NOT_FOUND ? nil : ((raw as EnvironmentValue) ?? nil);
          } catch (e) {
            if (e instanceof SandboxViolationError) return nil;
            throw e;
          }
        },
        {
          valueOf: () => symbol.__name__,
          // Explicit brand: the bare field name, for consumers like `dict` that
          // need to use a keyword as a key (not just call it as an accessor).
          [KEYWORD_ACCESSOR_FIELD]: key,
        },
      );
      return keyPluck as EnvironmentValue;
    }

    typecheck("Environment::get", symbol, ["symbol", "string"]);
    const { throwError = true } = options;

    // Normalize to string/symbol name
    let name: string | symbol = symbol as string | symbol;
    if (symbol instanceof SchemeSymbol || symbol instanceof SchemeString) {
      name = symbol.valueOf();
    }

    // First, try direct lookup for the literal symbol (handles names like %as.data)
    const directValue = this._lookupWithResolvers(name);
    if (directValue !== undefined) {
      return patch_value(directValue, null);
    }

    // Determine if this is a dot-notation symbol (e.g., foo.bar.baz)
    // Only try dot-notation if direct lookup failed
    let parts: string[] | undefined;
    if (symbol instanceof SchemeSymbol && (symbol as unknown as { [key: symbol]: string[] })[SchemeSymbol.object]) {
      // dot notation symbols from syntax-rules that are gensyms
      parts = (symbol as unknown as { [key: symbol]: string[] })[SchemeSymbol.object];
    } else if (typeof name === "string" && name.includes(".")) {
      parts = name.split(".").filter(Boolean);
    }

    // Handle dot notation: foo.bar.baz
    if (parts && parts.length > 1) {
      const [first, ...rest] = parts;
      // Use _lookupWithResolvers to find the base object
      const baseValue = this._lookupWithResolvers(first);
      if (baseValue !== undefined) {
        // Access nested properties
        return get(baseValue, ...rest);
      }
      // Base not found - fall through to error handling
    }

    if (throwError) {
      throw Object.assign(new Error(`Unbound variable \`${name.toString()}'`), {
        publicMessage: `symbol ${name.toString()} does not exist - look at list of available functions at tool description`,
      });
    }
    return undefined;
  }

  set(name: BindingName, value: EnvironmentValue | number | bigint, docValue: string | null = null): this {
    typecheck("Environment::set", name, ["string", "symbol"]);
    let storedValue: EnvironmentValue;

    // Numbers get special handling (convert to SchemeExact/SchemeInexact for typed numeric ops)
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        storedValue = new SchemeInexact(value);
      } else {
        storedValue = Number.isSafeInteger(value) ? new SchemeExact(BigInt(value)) : new SchemeInexact(value);
      }
    } else if (typeof value === "bigint") {
      storedValue = new SchemeExact(value);
    }
    // Already a Scheme value - pass through
    else if (isSchemeValue(value)) {
      storedValue = value;
    }
    // Primitives (boolean, string, symbol) pass through
    else if (typeof value === "boolean" || typeof value === "string" || typeof value === "symbol") {
      storedValue = value as EnvironmentValue;
    }
    // Functions pass through as-is (membrane wrapping happens at interop points, not storage)
    else if (typeof value === "function") {
      storedValue = value as EnvironmentValue;
    }
    // Error objects pass through unwrapped for exception handling (R7RSError, etc.)
    else if (value instanceof Error) {
      storedValue = value as EnvironmentValue;
    }
    // Objects get wrapped via membrane
    else {
      storedValue = fromJS(value) as EnvironmentValue;
    }

    let key: string | symbol;
    if (name instanceof SchemeSymbol) {
      key = name.__name__;
    } else if (name instanceof SchemeString) {
      key = name.valueOf();
    } else {
      key = name;
    }
    this.__env__[key as string] = storedValue;
    if (docValue) {
      this.doc(name, docValue, true);
    }
    return this;
  }

  constant(name: string, value: EnvironmentValue): this {
    invariant(!Object.hasOwn(this.__env__, name), `Environment::constant: ${name} already exists`);
    Object.defineProperty(this.__env__, name, {
      value,
      enumerable: true,
    });
    return this;
  }

  has(name: string): boolean {
    return this.__env__.hasOwnProperty(name);
  }

  ref(name: string): Environment | undefined {
    let env: Environment | null = this;
    while (true) {
      if (!env) {
        break;
      }
      if (env.has(name)) {
        return env;
      }
      env = env.__parent__;
    }
  }

  // -------------------------------------------------------------------------
  // :: Evaluation API
  // -------------------------------------------------------------------------

  parents(): Environment[] {
    let env: Environment | null = this;
    const result: Environment[] = [];
    while (env) {
      result.unshift(env);
      env = env.__parent__;
    }
    return result;
  }

  /**
   * Parse and evaluate Scheme code in this environment.
   * Returns the result of the last expression.
   *
   * @example
   * ```typescript
   * const env = Environment.fromModules([pureScheme]);
   * const result = await env.eval('(+ 1 2 3)'); // => 6
   * ```
   */
  async eval(code: string): Promise<SchemeValue> {
    // Generator path (run(evaluate(...))) rather than the legacy lips.evaluate.
    // Lazy import keeps the evaluator off Environment's module-init chain — the
    // edge is call-time only, so no init-order cycle. exec throws on error by
    // default, matching the old re-throwing handler.
    const { exec } = await import("./generator-exec.js");
    const results = await exec(code, { env: this });
    return results.length > 0 ? results[results.length - 1] : nil;
  }

  // -------------------------------------------------------------------------
  // :: Static factory for creating module-based environments
  // -------------------------------------------------------------------------

  /**
   * Evaluate a single pre-parsed expression in this environment.
   * Use this when you've already parsed the code.
   */
  async evalExpr(expr: SchemeValue): Promise<SchemeValue> {
    // Generator path, lazy-imported (see eval() above for the rationale).
    const { execExpr } = await import("./generator-exec.js");
    return execExpr(expr, { env: this });
  }
}
