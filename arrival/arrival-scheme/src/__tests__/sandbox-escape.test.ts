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
import { exec } from "../lips";
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
   * `f(2,3)` returns 5 (i.e. it's the real arithmetic op, not a stub).
   *
   * Secure invariant: eval with no env arg must default to the CALLER's env
   * (i.e. the sandbox), NOT to lipsGlobalEnv. Inside the sandbox, looking up
   * `+` should fail with Unbound — `+` isn't an exported sandbox binding.
   */
  it.fails("eval defaults to sandbox env, NOT global, when no env arg", async () => {
    await initBridge();
    // `+` is NOT in sandboxedEnv directly (sandbox uses scheme arithmetic),
    // but IS in lipsGlobalEnv (via applyToEnvironment in initBridge).
    // If eval correctly stays in caller env, this throws Unbound.
    await expect(exec("(eval (quote +))", { env: sandboxedEnv })).rejects.toThrow(/Unbound/);
  });

  /**
   * Sharper version: not just "reachable" but "actually invokable and computes
   * the real result". Catches a regression where eval gets locked down for
   * lookup but escaped values are still callable.
   */
  it.fails("eval-escaped function cannot be invoked to perform host computation", async () => {
    await initBridge();
    // Build a sandbox program that pulls + via eval and applies it.
    // Today: returns 5. Post-fix: throws Unbound at the eval site.
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
  it.fails("FORBIDDEN_IN_SANDBOX names cannot be reached via eval", async () => {
    await initBridge();
    for (const forbidden of ["load", "set-obj!", "new", "instanceof"]) {
      await expect(
        exec(`(eval (quote ${forbidden}))`, { env: sandboxedEnv }),
        `${forbidden} must not be reachable via eval-escape`
      ).rejects.toThrow(/Unbound/);
    }
  });

  /**
   * Audit finding: `LString.ts:139-156` — SchemeString grafts all
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
    const { SchemeString } = await import("../LString");
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
  it.fails("(make-string 1e8 ...) errors fast instead of allocating ~200MB", async () => {
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
  it.fails("(make-vector 1e8 ...) errors or completes fast (no host hang)", async () => {
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
  it.skip("TODO: infinite loop is bounded by a wall-clock budget (needs budget API)", async () => {
    // Once a budget API exists, something like:
    //   await expect(exec("(let loop () (loop))", { env: sandboxedEnv, budgetMs: 100 }))
    //     .rejects.toThrow(/budget/i);
    // For now, skipped — running this test without a budget would hang the run.
  });

  /**
   * Audit finding: `LSymbol.ts:23` — `static readonly list: Record<string, SchemeSymbol> = {}`.
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
    const { SchemeSymbol } = await import("../LSymbol");
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
  it.fails("deeply-nested input throws a graceful parse error, not stack overflow", async () => {
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
  it.fails("(equal? a b) on cyclic structures does not throw native JSON error", async () => {
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
   * any future PR that exposes AValue (e.g. as part of a debug pack) MUST NOT
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
   * Today, no sandbox path can reach `registerBoxer` (probe-confirmed above).
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
