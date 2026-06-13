import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelSpec } from "@here.build/arrival-inference";
import { Project } from "../project.js";
import { singletonRouter } from "@here.build/arrival-inference";
import { inferKey as key, seededCache } from "./_seeded-cache.js";

const counterStub = () => {
  let n = 0;
  const complete = vi.fn(async (_s: ModelSpec) => ({ value: `draw-${n++}` }));
  return { complete };
};

const neverBackend = singletonRouter({
  complete: async () => {
    throw new Error("backend hit — expected a content-cache replay");
  },
});

// (infer model prompt schema cache-key)
//   schema    = #f for "no schema"
//   cache-key = #f for "no distinguisher"

describe("infer — cache-key for multi-replay sampling", () => {
  it("identical args + same cache-key collapses to a single backend call", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = counterStub();
    project.bindInfer(createInferStore(singletonRouter(backend)));

    await project.run(`
      (car (infer "m" "same" #f "k1"))
      (car (infer "m" "same" #f "k1"))
    `);

    // Single-flight: the second `(infer …)` rides the first cell.
    expect(backend.complete).toHaveBeenCalledTimes(1);
  });

  it("identical args + DIFFERENT cache-key produces N distinct backend calls", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = counterStub();
    project.bindInfer(createInferStore(singletonRouter(backend)));

    await project.run(`
      (map (lambda (i) (car (infer "m" "same" #f (number->string i))))
           (list 0 1 2))
    `);

    expect(backend.complete).toHaveBeenCalledTimes(3);
  });

  it('omitting cache-key is distinct from cache-key "0"', async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(
      createInferStore(
        neverBackend,
        seededCache({
          [key("m", "same", null, null)]: "no-key",
          [key("m", "same", null, "0")]: "key-zero",
        }),
      ),
    );

    const a = await project.run(`(car (infer "m" "same"))`);
    const b = await project.run(`(car (infer "m" "same" #f "0"))`);

    expect(a).toBe("no-key");
    expect(b).toBe("key-zero");
  });

  it("schema and cache-key compose positionally", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(neverBackend, seededCache({ [key("m", "p", "S", "k")]: "hit" })));

    const value = await project.run(`(car (infer "m" "p" "S" "k"))`);
    expect(value).toBe("hit");
  });
});

describe("infer — always-list return shape", () => {
  it("wraps a scalar result in a single-element list", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(neverBackend, seededCache({ [key("m", "p", null, null)]: "hi" })));

    const value = await project.run(`(infer "m" "p")`);
    expect(value).toEqual(["hi"]);
  });

  it("passes a structured array through as-is", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.bindInfer(createInferStore(neverBackend, seededCache({ [key("m", "p", null, null)]: ["a", "b", "c"] })));

    const value = await project.run(`(infer "m" "p")`);
    expect(value).toEqual(["a", "b", "c"]);
  });
});
