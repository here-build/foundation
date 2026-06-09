/**
 * Sandbox unification guards (S8-CORE, 2026-06-09).
 *
 * Locks the audit's ST-partial: there must be exactly ONE sandbox binding set
 * and ONE enforced block list. Before this work there were TWO construction
 * paths (`sandboxedEnv` vs `createSandbox`/`PURE_SCHEME_BINDINGS`) and a dead
 * ADVISORY `FORBIDDEN_IN_SANDBOX` array that nothing consulted, so adding or
 * removing a name in one place silently failed to change the sandbox.
 *
 * These tests fail the moment the two paths drift apart again — which is the
 * whole point of the unification (the oracle's Σ layer reads the SAME bound
 * symbols production runs).
 */

import { describe, expect, it, beforeAll } from "vitest";
import { initBridge } from "../bridge";
import { sandboxedEnv, FORBIDDEN_IN_SANDBOX } from "../sandbox-env";
import { createSandbox, PURE_SCHEME_BINDINGS } from "../sandbox";

beforeAll(async () => {
  await initBridge();
  // Ensure the bootstrap-injected sandbox extras (threading macros, SRFI-1
  // helpers) have landed on `sandboxedEnv` before we snapshot its surface.
  await import("../index");
});

describe("S8-CORE: one enforced block list", () => {
  it("every FORBIDDEN_IN_SANDBOX name is genuinely Unbound in sandboxedEnv", () => {
    expect(FORBIDDEN_IN_SANDBOX.size).toBeGreaterThan(0);
    for (const forbidden of FORBIDDEN_IN_SANDBOX) {
      const value = sandboxedEnv.get(forbidden, { throwError: false });
      expect(value, `'${forbidden}' must NOT be bound in sandboxedEnv`).toBeUndefined();
    }
  });

  it("FORBIDDEN_IN_SANDBOX is the enforced Set (not the old advisory array)", () => {
    // The dead 36-entry array was an Array; the single source of truth is a Set.
    expect(FORBIDDEN_IN_SANDBOX).toBeInstanceOf(Set);
  });
});

describe("S8-CORE: one binding set across both entry points", () => {
  it("createSandbox exposes exactly the sandboxedEnv binding set", async () => {
    const sandbox = await createSandbox();

    const productionNames = new Set(Object.keys(sandboxedEnv.__env__));
    expect(productionNames.size).toBeGreaterThan(0);

    // The base module the public sandbox runs on is the production surface,
    // projected verbatim. Compare the KEY SETS, not resolved values: a few
    // allowlist entries (e.g. `let-values`) resolve to `undefined` in
    // production too — the point is that BOTH paths carry the identical names
    // with identical values, so neither can drift from the other.
    const baseEnv = sandbox.__parent__?.__env__ ?? {};
    const baseNames = new Set(Object.keys(baseEnv));

    // `nil` is always added on top of the projection; otherwise the sets match.
    baseNames.delete("nil");
    const prodWithoutNil = new Set(productionNames);
    prodWithoutNil.delete("nil");
    expect(baseNames).toEqual(prodWithoutNil);

    // And the values are the same references the production env holds.
    for (const name of prodWithoutNil) {
      expect(
        (baseEnv as Record<string, unknown>)[name],
        `'${name}' value must match sandboxedEnv`,
      ).toBe((sandboxedEnv.__env__ as Record<string, unknown>)[name]);
    }
  });

  it("PURE_SCHEME_BINDINGS is DERIVED from sandboxedEnv (single source of truth)", () => {
    const derived = new Set(PURE_SCHEME_BINDINGS);
    const production = new Set(Object.keys(sandboxedEnv.__env__));
    expect(derived).toEqual(production);

    // Mutating the enforced surface must be reflected immediately — proof the
    // list is a live view, not a stale hand-maintained copy. (Cleaned up after.)
    const probe = "__s8_unification_probe__";
    expect(PURE_SCHEME_BINDINGS).not.toContain(probe);
    sandboxedEnv.set(probe, 1);
    try {
      expect(PURE_SCHEME_BINDINGS).toContain(probe);
    } finally {
      sandboxedEnv.unset(probe);
    }
    expect(PURE_SCHEME_BINDINGS).not.toContain(probe);
  });

  it("no FORBIDDEN name leaks into the derived binding list", () => {
    const names = new Set(PURE_SCHEME_BINDINGS);
    for (const forbidden of FORBIDDEN_IN_SANDBOX) {
      expect(names.has(forbidden), `'${forbidden}' must not appear in the sandbox surface`).toBe(false);
    }
  });
});
