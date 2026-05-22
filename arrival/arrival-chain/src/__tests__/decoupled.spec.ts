import { describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "../model.js";
import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { runProjectWorker } from "../worker.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const pendingCount = (project: Project): number =>
  [...project.tasks.values()].filter((t) => t.result === null).length;

const echoStub = (delayMs = 0) =>
  vi.fn(async (s: ModelSpec) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return `echo(${s.model}):${s.prompt}`;
  });

describe("decoupled converge / worker topology", () => {
  it("run() emits tasks; an independent worker computes them", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const complete = echoStub();
    const ac = new AbortController();
    const worker = runProjectWorker(project, { backends: { complete }, signal: ac.signal });

    const value = await project.run(`
      (define a (car (infer "m" "p1")))
      (car (infer "m" (string-append a "/p2")))
    `);

    expect(String(value)).toContain("echo(m):");
    expect(complete).toHaveBeenCalledTimes(2);
    ac.abort(); await worker;
  });

  it("worker started AFTER run() is mid-await still resolves", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const program = `(infer "m" "alone")`;
    const running = project.run(program);

    await tick(20);
    expect(pendingCount(project)).toBe(1);

    const ac = new AbortController();
    const worker = runProjectWorker(project, { backends: { complete: echoStub() }, signal: ac.signal });

    expect(String(await running)).toContain("echo(m):");
    ac.abort(); await worker;
  });

  it("two workers on the same project share the work", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const ac = new AbortController();
    const w1 = runProjectWorker(project, { backends: { complete: echoStub(5) }, signal: ac.signal });
    const w2 = runProjectWorker(project, { backends: { complete: echoStub(5) }, signal: ac.signal });

    await project.run(`
      (apply string-append
        (map (lambda (n) (car (infer "m" n))) (list "x0" "x1" "x2" "x3")))
    `);

    expect(project.tasks.size).toBe(4);
    ac.abort(); await Promise.all([w1, w2]);
  });
});
