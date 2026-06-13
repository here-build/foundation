/**
 * Live call-stack capture at (infer) time.
 *
 * We already record, in `EvalTrace`, the full Invocation chain for every
 * task (`invocationByTask`). That gives us, for each `(infer …)` call,
 * the precise stack of enclosing forms at the moment the call fired —
 * which is exactly what the semantic-collapse layer needs.
 *
 * This test demonstrates the existing primitive in service of the new
 * use case: pull the call stack at a specific infer, then walk up
 * through enclosing pairs to discover the containing AST shape
 * (here: a `(map …)` HOF iteration).
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { detectShape } from "../ast-shapes.js";
import { createInferStore, InferBinding } from "@here.build/arrival-inference";
import type { Invocation } from "@here.build/arrival-provenance";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { EvalTrace } from "@here.build/arrival-provenance";

describe("live call-stack capture at (infer) time", () => {
  it("walks each task's invocation up to the enclosing AST shape", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: vi.fn(async (s: { prompt: string }) => ({ value: `seen:${s.prompt}` })),
        }),
      ),
    );

    project.addFile(
      "main.scm",
      `(map (lambda (x) (car (infer "m" (string-append "prompt-" (number->string x)))))
            (list 1 2 3))`,
    );

    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "s1",
      file: "main.scm",
      source: (project.findFile("main.scm")!.draft?.source ??
        project.findFile("main.scm")!.versions.at(-1)?.source) ?? "",
      trace,
    });
    await finished;

    // Each infer call minted a binding → invocation chain captured in the trace.
    const bindings = [...trace.invocationByTask.keys()].filter((k) => k instanceof InferBinding);
    expect(bindings.length).toBe(3);

    // For each binding, walk the invocation chain — the ENCLOSING forms.
    const containerKinds = new Set<string>();
    for (const task of bindings) {
      const inv = trace.invocationFor(task);
      expect(inv).toBeDefined();
      // Walk up through .parent until we find a shape we recognise as a
      // container (map/fold/loop/branch). The (lambda …) body sits inside
      // a (map …) call, so the chain head — once we cross the lambda's
      // body invocation — is the map form.
      let cur: Invocation | null = inv!.parent;
      while (cur) {
        const shape = detectShape(cur.node);
        if (
          shape.kind === "map" ||
          shape.kind === "fold" ||
          shape.kind === "branch" ||
          shape.kind === "loop-named-let"
        ) {
          containerKinds.add(shape.kind);
          break;
        }
        cur = cur.parent;
      }
    }

    // All three infers were under the same (map …) — semantic collapse can
    // group them into one Map ×3 node instead of three flat span entries.
    expect([...containerKinds]).toEqual(["map"]);
  });

  it("distinguishes infers in different containers (map vs branch)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        singletonRouter({
          complete: vi.fn(async (s: { prompt: string }) => ({ value: `seen:${s.prompt}` })),
        }),
      ),
    );

    project.addFile(
      "mix.scm",
      `(if #t
           (car (infer "m" "in-then"))
           (car (infer "m" "in-else")))
       (map (lambda (x) (car (infer "m" (string-append "in-map-" (number->string x)))))
            (list 1 2))`,
    );
    const trace = new EvalTrace();
    const { finished } = await project.sandboxRunTraced({
      id: "s2",
      file: "mix.scm",
      source: (project.findFile("mix.scm")!.draft?.source ??
        project.findFile("mix.scm")!.versions.at(-1)?.source) ?? "",
      trace,
    });
    await finished;

    // Group prompts by their innermost container shape.
    const promptsByContainer = new Map<string, string[]>();
    for (const task of trace.invocationByTask.keys()) {
      if (!(task instanceof InferBinding)) continue;
      const inv = trace.invocationFor(task);
      if (!inv) continue;
      let cur: Invocation | null = inv.parent;
      while (cur) {
        const shape = detectShape(cur.node);
        if (shape.kind === "map" || shape.kind === "branch") {
          const list = promptsByContainer.get(shape.kind) ?? [];
          list.push(task.prompt);
          promptsByContainer.set(shape.kind, list);
          break;
        }
        cur = cur.parent;
      }
    }

    expect(promptsByContainer.get("branch")?.sort()).toEqual(["in-then"]);
    expect(promptsByContainer.get("map")?.sort()).toEqual(["in-map-1", "in-map-2"]);
  });
});
