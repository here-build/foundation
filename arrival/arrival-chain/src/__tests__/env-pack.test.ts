// env-pack.test.ts — P0: the pure assembly core (closure/cycle/dedup/C3/apply).
// Design + test matrix: docs/working-proposals/env-pack-capability-dag-2026-06-13.md §11.

import { afterEach, describe, expect, it } from "vitest";

import {
  assembleEnv,
  assembleEnvSync,
  AssembleCycleError,
  AssembleConfigConflictError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError,
  type EnvPack,
} from "../env-pack.js";

// A stub env: records the order packs applied + the symbols they set.
interface Stub {
  appliedOrder: string[];
  syms: Map<string, unknown>;
}
const stub = (): Stub => ({ appliedOrder: [], syms: new Map() });

/** A pack that records its name into the env's applied-order on apply. */
function pack(name: string, deps: EnvPack<Stub>[] = [], extra: Partial<EnvPack<Stub>> = {}): EnvPack<Stub> {
  return {
    name,
    deps,
    apply: (env) => { env.appliedOrder.push(name); env.syms.set(name, true); },
    ...extra,
  };
}

afterEach(() => { delete process.env.ASSEMBLE_PACK_TIMEOUT_MS; });

describe("env-pack assembly core (P0)", () => {
  it("linear chain a→b→c: order highest-first; apply deps-first; each once", async () => {
    const c = pack("c");
    const b = pack("b", [c]);
    const a = pack("a", [b]);
    const r = await assembleEnv(stub(), [a]);
    expect(r.order).toEqual(["a", "b", "c"]);          // C3: highest precedence first
    expect(r.env.appliedOrder).toEqual(["c", "b", "a"]); // applied least-precedence first
  });

  it("diamond d→{b,c}, b→a, c→a: C3 == [d,b,c,a]; a applied once", async () => {
    const a = pack("a");
    const b = pack("b", [a]);
    const c = pack("c", [a]);
    const d = pack("d", [b, c]);
    const r = await assembleEnv(stub(), [d]);
    expect(r.order).toEqual(["d", "b", "c", "a"]);     // classic C3 diamond
    expect(r.env.appliedOrder.filter((n) => n === "a")).toHaveLength(1);
    expect(r.env.appliedOrder).toEqual(["a", "c", "b", "d"]);
  });

  it("dedup via 3 paths to one pack: applied exactly once", async () => {
    const shared = pack("shared");
    const x = pack("x", [shared]);
    const y = pack("y", [shared]);
    const r = await assembleEnv(stub(), [x, y, shared]); // shared reached 3 ways
    expect(r.env.appliedOrder.filter((n) => n === "shared")).toHaveLength(1);
  });

  it("cycle a→b→a throws AssembleCycleError with the path", async () => {
    const a: EnvPack<Stub> = { name: "a", apply: () => {} };
    const b: EnvPack<Stub> = { name: "b", deps: [a], apply: () => {} };
    (a as { deps?: EnvPack<Stub>[] }).deps = [b]; // close the cycle
    await expect(assembleEnv(stub(), [a])).rejects.toBeInstanceOf(AssembleCycleError);
  });

  it("same-name divergent config throws AssembleConfigConflictError", async () => {
    const fnA = () => 1, fnB = () => 2;
    const mcp1 = pack("mcp", [], { config: fnA });
    const mcp2 = pack("mcp", [], { config: fnB });
    const root = pack("root", [mcp1, mcp2]);
    await expect(assembleEnv(stub(), [root])).rejects.toBeInstanceOf(AssembleConfigConflictError);
  });

  it("same-name EQUAL config dedups silently", async () => {
    const shared = () => 1;
    const mcp1 = pack("mcp", [], { config: shared });
    const mcp2 = pack("mcp", [], { config: shared });
    const root = pack("root", [mcp1, mcp2]);
    const r = await assembleEnv(stub(), [root]);
    expect(r.env.appliedOrder.filter((n) => n === "mcp")).toHaveLength(1);
  });

  it("async apply (await import-shaped): env has the symbol after assemble resolves", async () => {
    const slow: EnvPack<Stub> = {
      name: "slow",
      apply: async (env) => { await Promise.resolve(); env.syms.set("slow/fn", 42); },
    };
    const r = await assembleEnv(stub(), [slow]);
    expect(r.env.syms.get("slow/fn")).toBe(42);
  });

  it("onDispose runs LIFO (reverse of apply)", async () => {
    const log: string[] = [];
    const mk = (name: string, deps: EnvPack<Stub>[] = []): EnvPack<Stub> => ({
      name, deps, apply: (_e, ctx) => { ctx.onDispose(() => { log.push(name); }); },
    });
    const c = mk("c"); const b = mk("b", [c]); const a = mk("a", [b]);
    const r = await assembleEnv(stub(), [a]);
    await r.dispose();
    // applied c,b,a → disposers pushed c,b,a → LIFO runs a,b,c
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("partial-assembly rollback: a throwing apply runs prior disposers and rejects", async () => {
    const disposed: string[] = [];
    const ok: EnvPack<Stub> = { name: "ok", apply: (_e, ctx) => { ctx.onDispose(() => disposed.push("ok")); } };
    const boom: EnvPack<Stub> = { name: "boom", deps: [ok], apply: () => { throw new Error("kaboom"); } };
    await expect(assembleEnv(stub(), [boom])).rejects.toBeInstanceOf(AssemblePackError);
    expect(disposed).toEqual(["ok"]); // ok applied before boom, so its disposer ran on rollback
  });

  it("apply timeout: a never-resolving apply trips AssemblePackTimeoutError", async () => {
    process.env.ASSEMBLE_PACK_TIMEOUT_MS = "40";
    const wedged: EnvPack<Stub> = { name: "wedged", apply: () => new Promise(() => {}) };
    await expect(assembleEnv(stub(), [wedged])).rejects.toBeInstanceOf(AssemblePackTimeoutError);
  });

  // ── assembleEnvSync (the P1 seam for sync buildArrivalEnv) ──
  it("assembleEnvSync applies sync packs in C3 order and returns the env", () => {
    const a = pack("a"); const b = pack("b", [a]);
    const r = assembleEnvSync(stub(), [b]);
    expect(r.order).toEqual(["b", "a"]);
    expect(r.env.appliedOrder).toEqual(["a", "b"]);
  });

  it("assembleEnvSync throws AssemblePackError if a pack's apply returns a Promise", () => {
    const asyncPack: EnvPack<Stub> = { name: "async", apply: async () => { await Promise.resolve(); } };
    expect(() => assembleEnvSync(stub(), [asyncPack])).toThrow(AssemblePackError);
  });

  // ── C3 SPEC-PARITY (G9): our linearization == Python's C3 on canonical cases ──
  describe("C3 spec-parity vs Python MRO", () => {
    it("the classic K1/K2/K3/Z hierarchy matches Python's documented MRO", async () => {
      // From the C3 paper / Python docs. Python MRO of Z (dropping object):
      //   Z, K1, K2, K3, D, A, B, C, E
      const A = pack("A"), B = pack("B"), C = pack("C"), D = pack("D"), E = pack("E");
      const K1 = pack("K1", [A, B, C]);
      const K2 = pack("K2", [D, B, E]);
      const K3 = pack("K3", [D, A]);
      const Z = pack("Z", [K1, K2, K3]);
      const r = await assembleEnv(stub(), [Z]);
      expect(r.order).toEqual(["Z", "K1", "K2", "K3", "D", "A", "B", "C", "E"]);
    });

    it("an inconsistent hierarchy Python REJECTS, we reject too (AssembleLinearizationError)", async () => {
      // a wants [x,y]; b wants [y,x]; c(a,b) — no consistent linearization. Python raises TypeError.
      const x = pack("x"), y = pack("y");
      const a = pack("a", [x, y]);
      const b = pack("b", [y, x]);
      const c = pack("c", [a, b]);
      await expect(assembleEnv(stub(), [c])).rejects.toBeInstanceOf(AssembleLinearizationError);
    });
  });
});
