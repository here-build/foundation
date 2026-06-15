/**
 * CRITICAL: Sandbox security findings — each test corresponds to a specific
 * known attack vector or resource-exhaustion bug.
 *
 * War-story format: every test cites (a) the audit finding it covers, (b) the
 * file:line that is the source of the bug, and (c) the secure invariant we
 * *want* to hold. Tests marked `.fails` describe the desired post-fix
 * behavior — they are RED today; when the fix lands they will flip to GREEN
 * and vitest will fail until `.fails` is removed.
 *
 * Probe origin: ran experimental probe (`_sandbox-escape-probe.test.ts`,
 * deleted) against current main on 2026-05-28 to confirm each vector. Findings
 * live as comments below — do not delete them without re-running the probe.
 *
 * Vitest API note: `it.fails(name, fn)` is the vitest 4 spelling of "this test
 * is expected to fail." When the underlying bug is fixed and the test starts
 * passing, vitest reports the suite as failed, forcing the `.fails` marker to
 * be removed. (Vitest 3+ docs sometimes call this `.failing`; in vitest 4 the
 * canonical name is `.fails`.)
 */

import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge";
import { exec } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import {
  SANDBOX_BOUNDARY,
  isSandboxBoundary,
} from "../sandbox-boundary";

// ============================================================================
// CRITICAL: sandbox escape vectors
// ============================================================================
//
// Audit finding: `bridge.ts:1342` — `eval(expr, env?) { return evaluate(expr, { env: env || lipsGlobalEnv }) }`
// When Scheme code calls `(eval x)` with no second argument, the host-side
// `env` parameter is `undefined`, so eval falls back to `lipsGlobalEnv`. The
// global env contains EVERY wrappedOps entry (~hundreds of names: `+`, `*`,
// `load`, `set-obj!`, `new`, `instanceof`, plus the entire LIPS bootstrap).
// Any of those are reachable from inside the sandbox via
// `(eval (quote name))`. The returned value is the unwrapped JS function.
// ============================================================================

describe("CRITICAL: sandbox escape vectors", () => {
  /**
   * The smoking gun. `+` is in wrappedOps, so it's in lipsGlobalEnv. The
   * sandbox doesn't export `+` by JS-name but it does export `(eval)`; calling
   * `(eval (quote +))` reaches into the global env and hands the sandbox the
   * unwrapped JS function. Probe confirmed: returned value IS callable, and
   * `f(2,3)` returns 5 (i.e., it's the real arithmetic op, not a stub).
   *
   * Secure invariant: eval with no env arg must default to the CALLER's env
   * (i.e., the sandbox), NOT to lipsGlobalEnv. Inside the sandbox, looking up
   * `+` should fail with Unbound — `+` isn't an exported sandbox binding.
   */
  it("eval defaults to sandbox env, NOT global, when no env arg", async () => {
    await initBridge();
    // `+` is NOT in sandboxedEnv directly (sandbox uses scheme arithmetic),
    // but IS in lipsGlobalEnv (via applyToEnvironment in initBridge).
    // Post-#43 fix: eval is no longer in sandboxedEnv (FORBIDDEN_IN_SANDBOX
    // strip in sandbox-env.ts), so the eval-escape path is closed entirely —
    // the throw is Unbound on `eval` itself, not on `+`.
    await expect(exec("(eval (quote +))", { env: sandboxedEnv })).rejects.toThrow(/Unbound/);
  });

  /**
   * Sharper version: not just "reachable" but "actually invokable and computes
   * the real result". Catches a regression where eval gets locked down for
   * lookup but escaped values are still callable.
   */
  it("eval-escaped function cannot be invoked to perform host computation", async () => {
    await initBridge();
    // Build a sandbox program that pulls + via eval and applies it.
    // Pre-#43: returned 5 (eval-escape worked).
    // Post-#43: throws Unbound at the eval site — eval is no longer in the
    // sandbox env, so the very first form `(eval ...)` fails to resolve.
    await expect(
      exec(`((eval (quote +)) 2 3)`, { env: sandboxedEnv })
    ).rejects.toThrow(/Unbound/);
  });

  /**
   * `load` and `set-obj!` are in FORBIDDEN_IN_SANDBOX (modules/pure-scheme.ts:336,353)
   * — explicitly listed as "should not be available". They're not bound under
   * those names in sandboxedEnv, but the LIPS bootstrap registers them in
   * lipsGlobalEnv, so the eval-escape reaches them anyway. Probe confirmed
   * both return JS Function from `(eval (quote load))` / `(eval (quote set-obj!))`.
   *
   * `set-obj!` is the worst of the three: it can install arbitrary properties
   * on arbitrary JS objects, which combined with the eval escape lets a
   * sandbox program mutate host state.
   */
  it("FORBIDDEN_IN_SANDBOX names cannot be reached via eval", async () => {
    await initBridge();
    // Post-#43 fix: `eval` itself is no longer in sandboxedEnv, so the lookup
    // of `eval` in the head position fails before the forbidden name is even
    // quoted. The error message is Unbound on `eval`, not on the inner name —
    // but the security invariant ("forbidden name not reachable") holds.
    for (const forbidden of ["load", "set-obj!", "new", "instanceof"]) {
      await expect(
        exec(`(eval (quote ${forbidden}))`, { env: sandboxedEnv }),
        `${forbidden} must not be reachable via eval-escape`
      ).rejects.toThrow(/Unbound/);
    }
  });

  /**
   * Audit finding: `SchemeString.ts:139-156` — SchemeString grafts all
   * String.prototype methods onto its own prototype as own enumerable
   * properties. Because they're OWN properties (not inherited), the existing
   * `sandboxedAccess` boundary check at sandbox-boundary.ts:284 takes the
   * fast-path and returns them. The class itself is not marked as a sandbox
   * boundary, so a sandbox holding a SchemeString reference can call
   * `(@ str "constructor")` … well, constructor IS in BLOCKED_PROPERTY_NAMES,
   * so that specific path is blocked — but every other String.prototype method
   * is exposed. The boundary marker is what's missing.
   *
   * Secure invariant: SchemeString (and other AValue subtypes that graft
   * built-in proto methods) must be marked as sandbox boundaries so the
   * prototype-chain walk in sandboxedAccess stops at them.
   */
  it("SchemeString is marked as a sandbox boundary", async () => {
    const { SchemeString } = await import("../SchemeString");
    // Direct check, two ways the marker can be present:
    const protoMarked =
      Object.prototype.hasOwnProperty.call(SchemeString.prototype, SANDBOX_BOUNDARY) &&
      (SchemeString.prototype as Record<symbol, unknown>)[SANDBOX_BOUNDARY] === true;
    const ctorMarked =
      Object.prototype.hasOwnProperty.call(SchemeString, SANDBOX_BOUNDARY) &&
      (SchemeString as unknown as Record<symbol, unknown>)[SANDBOX_BOUNDARY] === true;
    expect(protoMarked || ctorMarked).toBe(true);
    expect(isSandboxBoundary(SchemeString.prototype)).toBe(true);
  });
});

// ============================================================================
// CRITICAL: accessor isolation leaks (dot-notation `get` + `:keyword` plucker)
// ============================================================================
//
// Audit finding (2026-05-30, require/import loader plan): field retrieval IS
// gated for `@`/`field` (they route through `sandboxedAccess` →
// SchemeJSObject.get), but TWO other property-access paths bypass it for RAW
// (non-SchemeJSObject) values:
//   - `lips.ts` `get` (dot-notation `x.y`) — `else` branch does raw `object[name]`.
//   - `Environment.ts` `:keyword` plucker — raw branch does `obj[key]` after
//     `Object.hasOwn`, never consulting BLOCKED_PROPERTY_NAMES.
// A lambda / rosetta is a raw JS function in sandbox scope, so `(:constructor f)`
// or `f.constructor` walks to `Function.prototype.constructor` → the `Function`
// constructor → `((:constructor f) "return process")()` is RCE.
//
// Secure invariant: both paths route through the SAME `sandboxedAccess`
// isolation as `@` — blocked names (constructor, __proto__, prototype, …) and
// boundary-crossing inherited props collapse to nil/undefined.
// ============================================================================

describe("CRITICAL: accessor isolation leaks", () => {
  it(":keyword plucking 'constructor' off a lambda does not leak Function", async () => {
    await initBridge();
    const [fromLambda] = await exec("(:constructor (lambda (x) x))", { env: sandboxedEnv });
    // Pre-fix: === Function (RCE primitive). Post-fix: nil.
    expect(fromLambda).not.toBe(Function);
  });

  it(":keyword plucking '__proto__' / 'prototype' off a lambda is blocked", async () => {
    await initBridge();
    const [proto] = await exec("(:prototype (lambda (x) x))", { env: sandboxedEnv });
    const [dunder] = await exec("(:__proto__ (lambda (x) x))", { env: sandboxedEnv });
    expect(proto).not.toBe(Function.prototype);
    // __proto__ must not hand back Function.prototype (→ chains to constructor).
    expect(dunder).not.toBe(Object.getPrototypeOf(() => {}));
  });

  it("lips get() (dot-notation accessor) blocks raw constructor/__proto__ access", async () => {
    // `get` is the dot-notation property accessor (`foo.bar` → get(foo, "bar"),
    // routed via Environment.get's dotted resolution). On a raw function its
    // `else` branch used to do `object[name]` — so get(fn, "constructor") handed
    // back the Function constructor (RCE). It now routes through sandboxedAccess.
    const { get } = await import("../stdlib");
    const fn = (x: number) => x;
    expect(get(fn, "constructor")).toBeUndefined();
    expect(get(fn, "__proto__")).toBeUndefined();
    expect(get(fn, "prototype")).toBeUndefined();
    // Inherited built-in proto methods are past a sandbox boundary → blocked.
    expect(get([1, 2, 3], "map")).toBeUndefined();
    // Benign own-property access still resolves (guard against over-blocking).
    // `get` boxes the result through `patch_value` (numbers → SchemeExact), so
    // assert "not blocked" + the unboxed value rather than raw identity.
    expect(get({ a: 1, b: 2 }, "a")).not.toBeUndefined();
    expect(String(get({ a: 1, b: 2 }, "a"))).toBe("1");
    expect(String(get([1, 2, 3], "length"))).toBe("3");
  });

  it("benign :keyword and dot access on a plain object still resolve", async () => {
    await initBridge();
    // Guard against over-blocking: legitimate own-property access must keep
    // working through both paths after the isolation is applied.
    sandboxedEnv.set("__probe_obj", { name: "maya", nested: { city: "lisbon" } });
    const [byKeyword] = await exec("(:name __probe_obj)", { env: sandboxedEnv });
    expect(String(byKeyword)).toBe("maya");
  });
});

// ============================================================================
// CRITICAL: resource exhaustion (DoS vectors)
// ============================================================================

describe("CRITICAL: resource exhaustion (DoS vectors)", () => {
  /**
   * Audit finding: `bridge.ts:662` — `make-string` has no upper bound on `k`.
   * Probe confirmed: `(make-string 100000000 #\x)` allocates a 200MB string
   * in ~1ms and returns successfully. A sandbox-level attacker can drive
   * memory pressure across the host with a single call.
   *
   * V8 enforces its own string-length cap (~2^29 bytes), so very large
   * requests like 1e9 happen to throw RangeError — but for the WRONG reason
   * (engine limit, not our policy). The DoS attack window is exactly the
   * range BELOW V8's cap and ABOVE what a sandbox should be allowed to
   * allocate. We pick 1e8 (200MB UTF-16) to test the policy gap: V8 accepts
   * this, our code should reject it.
   *
   * Secure invariant: `make-string` with a length > some host-configured cap
   * must throw a cap-related error in O(1), not allocate.
   */
  it("(make-string 1e8 ...) errors fast instead of allocating ~200MB", async () => {
    await initBridge();
    const start = Date.now();
    let caught = false;
    try {
      await exec("(make-string 100000000 #\\x)", { env: sandboxedEnv });
    } catch {
      caught = true;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  /**
   * Audit finding: `bridge.ts:1076` — `make-vector` calls `Array.from({ length: k })`.
   * Probe confirmed: `(make-vector 100000000 #f)` runs >10s and exhausts memory
   * trying to materialize 100M slots. `(make-vector 1000000000 ...)` typically
   * throws RangeError synchronously (engine limit ~2^32), but the cap belongs
   * in OUR code, not in the engine's worst-case behavior.
   *
   * Secure invariant: same as make-string — host-configurable cap, error fast.
   */
  it("(make-vector 1e8 ...) errors or completes fast (no host hang)", async () => {
    await initBridge();
    const start = Date.now();
    let caught = false;
    try {
      await exec("(make-vector 100000000 #f)", { env: sandboxedEnv });
    } catch {
      caught = true;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBe(true);
    expect(elapsed).toBeLessThan(500);
  }, 15000);

  /**
   * Audit finding: `evaluator.ts:411` — `run()` is the generator trampoline.
   * It has no wall-clock budget, no instruction counter, no cancellation.
   * Sandbox code can `(let loop () (loop))` forever; the host has no way to
   * reclaim the worker except by killing the process.
   *
   * Secure invariant: each `run()` invocation should honor a budget (either
   * passed via options or a per-host default). Exceeding the budget should
   * throw a recoverable error, not hang forever.
   *
   * This test DOCUMENTS the missing infra rather than exploits it — actually
   * running `(let loop () (loop))` with no budget would hang the test runner.
   * The shape is: when budget infra exists, this test will compile against
   * its public API and the .failing marker can be removed.
   */
  it("infinite loop is bounded by a wall-clock budget (budgetMs)", async () => {
    await initBridge();
    // The budget lives on the GENERATOR-EXEC trampoline (`run()` in
    // evaluator.ts), which is the path the actual sandbox/MCP runtime uses
    // (arrival-chain's loader calls `execGeneratorExpr`). The file-level `exec`
    // import is `lips.exec` (legacy REPL evaluator) — used by the other tests
    // here — so we import the generator-exec `exec` locally for the budget API.
    // `budgetMs` throws a SchemeError(/budget/) at the existing 1000-iter / 5ms
    // event-loop yield once the deadline passes; it composes with `signal`
    // (whichever fires first wins). See evaluator.ts RunOptions.budgetMs.
    const { exec: gexec } = await import("../generator-exec");
    const start = Date.now();
    // `(let loop () (loop))` is now flat under TCO (task #46), so the budget
    // fires cleanly instead of the loop blowing the JS stack first.
    await expect(
      gexec("(let loop () (loop))", { env: sandboxedEnv, budgetMs: 150 }),
    ).rejects.toThrow(/budget/i);
    // Bounded to ~one yield cadence past the 150ms deadline.
    expect(Date.now() - start).toBeLessThan(2000);
  }, 10000);

  /**
   * Audit finding: `SchemeSymbol.ts:23` — `static readonly list: Record<string, SchemeSymbol> = {}`.
   * Every `(string->symbol unique-string)` interns a new entry; the map never
   * evicts. Sandbox code can mint distinct symbols in a loop until the host
   * OOMs. Probe confirmed: 1000 distinct `new SchemeSymbol(name)` adds exactly
   * 1000 entries.
   *
   * This is DOCUMENTED, not RED — fixing it requires either an LRU policy or
   * per-trace scoping of the intern table. The test is here so any future
   * "we fixed it" PR has a behavior to assert against.
   *
   * Not `.fails` because asserting "intern table has bounded size after N
   * inserts" requires the bound to exist first. Leaving as a documented
   * behavior pin.
   */
  it("DOCUMENTED: string->symbol of N distinct names creates N intern entries", async () => {
    const { SchemeSymbol } = await import("../SchemeSymbol");
    const before = Object.keys(SchemeSymbol.list).length;
    const N = 500;
    for (let i = 0; i < N; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      new SchemeSymbol(`__test-intern-doc-${Date.now()}-${i}`);
    }
    const after = Object.keys(SchemeSymbol.list).length;
    // Current behavior: grows by N. When a bound exists, this should
    // become `expect(after - before).toBeLessThanOrEqual(BOUND)`.
    expect(after - before).toBe(N);
  });

  /**
   * Audit finding: `Parser.ts:360` (`_read_object`) is mutually recursive with
   * `read_list` via real JS call frames. Deeply nested input overflows the
   * native stack BEFORE the parser can produce a structured error. Probe
   * confirmed: 5000-deep input throws "Maximum call stack size exceeded" —
   * a host-level error that leaks implementation details and may not be
   * catchable depending on engine.
   *
   * Secure invariant: deeply-nested input throws a Scheme-level parse error
   * with a clear message ("input nesting depth exceeded N"), not a native
   * RangeError. The parser should track depth explicitly and bail.
   */
  it("deeply-nested input throws a graceful parse error, not stack overflow", async () => {
    await initBridge();
    const deep = "(".repeat(10000) + "1" + ")".repeat(10000);
    let err: Error | undefined;
    try {
      await exec(deep, { env: sandboxedEnv });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // The native message is "Maximum call stack size exceeded" — we want
    // anything BUT that.
    expect(err?.message).not.toMatch(/Maximum call stack/i);
    // Ideally something like /nest|depth|too deep/i
  });

  /**
   * Audit finding: `sandbox-env.ts:217` — `equal?` falls through to
   * `JSON.stringify(a) === JSON.stringify(b)` as its general path. JSON.stringify
   * throws TypeError on cyclic structures. Probe confirmed: comparing two
   * cyclic JS objects throws "Converting circular structure to JSON" — a
   * native error message that leaks host implementation, and the exception
   * is not a Scheme-level error so sandbox code can't `guard` it cleanly.
   *
   * Secure invariant: `equal?` on any input pair should return a boolean or
   * throw a Scheme-level error. Cyclic structures should compare via
   * structural-equality-with-occurs-check, not JSON.stringify.
   */
  it("(equal? a b) on cyclic structures does not throw native JSON error", async () => {
    await initBridge();
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    sandboxedEnv.set("__cyc_a", a);
    sandboxedEnv.set("__cyc_b", b);

    let err: Error | undefined;
    let result: unknown;
    try {
      [result] = await exec("(equal? __cyc_a __cyc_b)", { env: sandboxedEnv });
    } catch (e) {
      err = e as Error;
    }
    // Either:
    //   (a) returns a boolean (preferred — structural equality with occurs-check), OR
    //   (b) throws a Scheme-level error whose message does NOT mention "JSON"
    //       or "circular structure"
    if (err) {
      expect(err.message).not.toMatch(/circular structure|JSON/i);
    } else {
      expect(typeof result === "boolean" || result === true || result === false).toBe(true);
    }
  });
});

// ============================================================================
// Registry poisoning vectors
// ============================================================================
//
// Audit finding: `AValue.ts:51` — `AValue.registerBoxer(tag, fn)` is a static
// method with no access control. Anyone holding the AValue class can replace
// any boxer (string, number, boolean, etc.). Since `fromJs` is on the hot path
// for JS→Scheme membrane crossing, a malicious boxer would intercept every
// future value coming in. Combined with the eval-escape, AValue would be a
// devastating reach — confirm it is NOT directly reachable from the sandbox.
// ============================================================================

describe("registry poisoning vectors", () => {
  /**
   * Probe confirmed: `(eval (quote AValue))` throws Unbound — AValue is not
   * registered in lipsGlobalEnv under that name. Good. This test pins that:
   * any future PR that exposes AValue (e.g., as part of a debug pack) MUST NOT
   * land without also wrapping it.
   */
  it("AValue is NOT reachable from sandbox via direct lookup", async () => {
    await initBridge();
    await expect(exec("AValue", { env: sandboxedEnv })).rejects.toThrow(/Unbound/);
  });

  /**
   * Same check via the eval-escape path. Even after the eval-escape fix lands,
   * this pin remains valid — AValue should never be exported.
   */
  it("AValue is NOT reachable from sandbox via (eval (quote AValue))", async () => {
    await initBridge();
    await expect(exec("(eval (quote AValue))", { env: sandboxedEnv })).rejects.toThrow(/Unbound/);
  });

  /**
   * Documents what would happen if the boxer registry were ever poisoned.
   * Today no sandbox path can reach `registerBoxer` (probe-confirmed above).
   * This test is here as the canary: the day someone wraps and exposes AValue,
   * `registerBoxer` becomes a critical attack vector. The test asserts the
   * registry has NO access-control surface today — a hardening fix should
   * either:
   *   (a) freeze the registry after init, OR
   *   (b) move registerBoxer behind a non-enumerable internal symbol
   * After such a fix, this test should be updated to assert the new control.
   */
  it("DOCUMENTED: AValue.registerBoxer has no access control today", async () => {
    const { AValue } = await import("../AValue");
    // registerBoxer is an exposed static method. No frozen check, no symbol
    // guard. If AValue ever leaks to the sandbox, this is a direct write to
    // a global registry. Test pin: any PR that hardens the registry should
    // flip this assertion.
    expect(typeof AValue.registerBoxer).toBe("function");
    // Negative pin — if we ever freeze the class:
    expect(Object.isFrozen(AValue)).toBe(false);
  });
});

// ============================================================================
// CRITICAL: write-side prototype pollution (S6)
// ============================================================================
//
// Audit finding (S6): the READ side (sandboxedAccess) is boundary-guarded, but
// the WRITE side was RAW. Two holes:
//   - sandbox-boundary.ts sandboxedSet: `data[keyStr] = value` walks the proto
//     chain and fires inherited setters → defineProperty installs OWN only.
//   - SchemeSymbol.ts `SchemeSymbol.list` was a plain `{}` (inherits Object.proto),
//     so `(string->symbol "__proto__")` could pollute Object.prototype.
// ============================================================================

describe("CRITICAL: write-side prototype pollution (S6)", () => {
  it("string->symbol of '__proto__' does not pollute Object.prototype", async () => {
    const { SchemeSymbol } = await import("../SchemeSymbol");
    // Minting symbols named after dangerous keys must touch only the intern
    // table as own keys — never reach Object.prototype.
    for (const name of ["__proto__", "constructor", "prototype"]) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      new SchemeSymbol(name);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Object.prototype must remain a clean baseline (no foreign own keys added).
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "__proto__sentinel__")).toBe(false);
    // The intern table itself must have a null prototype (no inherited keys).
    expect(Object.getPrototypeOf(SchemeSymbol.list)).toBeNull();
  });

  it("sandboxedSet('__proto__', ...) is rejected as a blocked key", async () => {
    const { sandboxedSet, SandboxViolationError } = await import("../sandbox-boundary");
    const target: Record<string, unknown> = {};
    expect(() => sandboxedSet(target, "__proto__", { evil: true })).toThrow(SandboxViolationError);
    expect(() => sandboxedSet(target, "constructor", 1)).toThrow(SandboxViolationError);
    expect(() => sandboxedSet(target, "prototype", 1)).toThrow(SandboxViolationError);
  });

  it("sandboxedSet installs an OWN data property without firing inherited setters", async () => {
    const { sandboxedSet } = await import("../sandbox-boundary");
    let setterFired = false;
    // A poisoned setter on a prototype must NOT fire on assignment.
    const proto = {};
    Object.defineProperty(proto, "danger", {
      set() {
        setterFired = true;
      },
      configurable: true,
    });
    const target: Record<string, unknown> = Object.create(proto);
    sandboxedSet(target, "danger", 42);
    expect(setterFired).toBe(false);
    // The value landed as an OWN data property on the target.
    expect(Object.prototype.hasOwnProperty.call(target, "danger")).toBe(true);
    expect(target.danger).toBe(42);
  });

  it("SANDBOX_BOUNDARY sentinel is not forgeable from the global Symbol registry", async () => {
    const { SANDBOX_BOUNDARY } = await import("../sandbox-boundary");
    // A module-local Symbol() is never equal to a registry symbol of any key.
    expect(SANDBOX_BOUNDARY).not.toBe(Symbol.for("scheme:sandbox-boundary"));
  });
});
