/**
 * The human-in-the-loop approval gate — `(run/continue-after-approval spec result)`.
 *
 * A PREAMBLE MACRO that THUNKS `result` and lowers to `(approval/await spec
 * (lambda () result))`, so the irreversible value isn't computed until a human
 * signs off (the membrane rule — no approval concept in the pure dataflow core).
 *
 *   - LOCAL (no approver wired): auto-approves, the thunk runs, result flows.
 *   - WIRED `onApprovalRequest`: the host receives the request; flipping
 *     `approved` releases the (possibly edited) value; `rejected` fails the branch.
 *   - The thunk does NOT run before approval (proven with a side-effect counter).
 *   - Fan-out: an auto-approving branch completes while another is parked.
 */
import { execGeneratorFromString as exec, schemeToJs } from "@here.build/arrival-scheme";
import { describe, expect, it, vi } from "vitest";

import { type FunctionRunApprovalRequest, type OnApprovalRequest } from "../approval.js";
import { loaderFromResolver } from "../loader.js";
import { BUILTIN_PREAMBLE, buildArrivalEnv } from "../project.js";

/** Evaluate a program and bridge the LAST top-level form's value to plain JS. */
const run = async (src: string, env: Awaited<ReturnType<typeof buildArrivalEnv>>): Promise<unknown> => {
  const results = schemeToJs(await exec(src, { env }), {});
  return Array.isArray(results) ? results.at(-1) : results;
};

async function envWith(opts?: { onApprovalRequest?: OnApprovalRequest }): Promise<Awaited<ReturnType<typeof buildArrivalEnv>>> {
  const env = await buildArrivalEnv({
    name: "approval-test",
    infer: async () => "stub",
    loader: loaderFromResolver(async () => {
      throw new Error("no requires in this test");
    }),
    onApprovalRequest: opts?.onApprovalRequest,
  });
  await exec(BUILTIN_PREAMBLE, { env });
  return env;
}

describe("run/continue-after-approval (local auto-approve)", () => {
  it("auto-approves locally — the thunk runs and the result flows", async () => {
    const env = await envWith();
    const out = await run(`(run/continue-after-approval (list "deploy") (+ 1 2))`, env);
    expect(out).toBe(3);
  });

  it("runs the thunk under local auto-approve (approval is immediate)", async () => {
    const env = await envWith();
    const out = await run(`(run/continue-after-approval (list "x") 99)`, env);
    expect(out).toBe(99);
  });
});

describe("run/continue-after-approval (wired approver)", () => {
  it("hands the host a request; setting approved releases the result", async () => {
    let captured: FunctionRunApprovalRequest | undefined;
    const env = await envWith({
      onApprovalRequest: (req) => {
        captured = req;
        // Approve on the next microtask so the run is genuinely parked first.
        queueMicrotask(() => req.approve());
      },
    });
    const out = await run(`(run/continue-after-approval (list "deploy" "prod") 42)`, env);
    expect(out).toBe(42);
    expect(captured).toBeDefined();
    expect(schemeToJs(captured!.spec, {})).toEqual(["deploy", "prod"]);
  });

  it("an approve-time value override wins over the thunk's value", async () => {
    const env = await envWith({
      onApprovalRequest: (req) => {
        // approve(by, value) — the override (reserved edit-then-approve path)
        queueMicrotask(() => req.approve("alice", "edited-by-human"));
      },
    });
    const out = await run(`(run/continue-after-approval (list "x") "proposed")`, env);
    expect(out).toBe("edited-by-human");
  });

  it("rejection fails the branch — the thunk never runs", async () => {
    const ran = vi.fn();
    const env = await envWith({
      onApprovalRequest: (req) => {
        queueMicrotask(() => req.reject("not allowed"));
      },
    });
    // The thunk increments a JS-visible counter via an injected proc. We model
    // the side effect with a rosetta so we can observe it from JS.
    env.defineRosetta("test/side-effect", { fn: () => (ran(), "did-run") });
    await expect(exec(`(run/continue-after-approval (list "x") (test/side-effect))`, { env })).rejects.toThrow(
      /approval rejected: not allowed/i,
    );
    expect(ran).not.toHaveBeenCalled();
  });

  it("the thunk does NOT run before approval (side-effect counter stays 0 while parked)", async () => {
    const ran = vi.fn();
    let req: FunctionRunApprovalRequest | undefined;
    const env = await envWith({
      onApprovalRequest: (r) => {
        req = r;
      },
    });
    env.defineRosetta("test/side-effect", { fn: () => (ran(), "did-run") });
    const p = run(`(run/continue-after-approval (list "x") (test/side-effect))`, env);
    // Let the run reach the parked await.
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).not.toHaveBeenCalled(); // parked — thunk not run yet
    expect(req).toBeDefined();
    req!.approve();
    await p;
    expect(ran).toHaveBeenCalledTimes(1); // ran only after approval
  });
});

describe("fan-out", () => {
  it("an auto-approving run completes while another is parked on a non-auto request", async () => {
    let parked: FunctionRunApprovalRequest | undefined;
    const wiredEnv = await envWith({
      onApprovalRequest: (r) => {
        parked = r;
      },
    });
    const localEnv = await envWith();

    const parkedRun = run(`(run/continue-after-approval (list "slow") 1)`, wiredEnv);
    const fastRun = run(`(run/continue-after-approval (list "fast") 7)`, localEnv);

    // The local branch resolves without the parked one being approved.
    expect(await fastRun).toBe(7);
    expect(parked).toBeDefined();

    // Now release the parked branch.
    parked!.approve();
    expect(await parkedRun).toBe(1);
  });
});
