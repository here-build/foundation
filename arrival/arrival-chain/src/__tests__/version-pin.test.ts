/**
 * Version-set pinning (NODE A7) — a run binds the WHOLE project's version-set at
 * invoke-start, so `(require)`d libraries are read at the exact version the run
 * saw, not `versions.at(-1)`. Closes the multi-file replay / live-draft tear:
 * the entry-only `versionIndex` pin couldn't cover transitive requires.
 *
 * These tests deliberately avoid the run's effect-log surface — they assert only
 * the version-pin behavior, which is orthogonal to what gets logged.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { createInferStore } from "../infer-store.js";
import { makeProjectLoader } from "../loader.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";
import { RunResult } from "../run.js";

const neverBackend = singletonRouter({
  complete: async () => {
    throw new Error("backend hit — this suite is pure (no inference)");
  },
});

const fresh = () => {
  const project = ArrivalChain.bootstrap(new Project()).root;
  project.bindInfer(createInferStore(neverBackend));
  return project;
};

const waitFor = async (cond: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("captureVersionSet", () => {
  it("snapshots every file's latest index; skips files with no published version", () => {
    const project = fresh();
    project.addFile("a.scm", `(define a 1)`); // version 0
    project.addFile("b.scm", `(define b 2)`); // version 0
    const b = project.findFile("b.scm")!;
    project.transact(() => b.publish(`(define b 3)`)); // version 1

    // A file present but never published (no versions) is omitted — nothing to pin.
    project.addFile("empty.scm"); // addFile with no source ⇒ versions.length === 0

    const set = project.captureVersionSet();
    expect(set.get("a.scm")).toBe(0);
    expect(set.get("b.scm")).toBe(1); // the LATEST at capture time
    expect(set.has("empty.scm")).toBe(false);
  });
});

describe("makeProjectLoader(project, versionSet) — pinned read", () => {
  it("serves the pinned version of a file, not the latest", async () => {
    const project = fresh();
    project.addFile("lib.scm", `(define greeting "v0")`); // version 0
    const lib = project.findFile("lib.scm")!;

    const pinned = makeProjectLoader(project, new Map([["lib.scm", 0]]));
    project.transact(() => lib.publish(`(define greeting "v1")`)); // version 1 lands AFTER the pin

    // Default loader reads latest; the pinned loader reads version 0.
    expect(await makeProjectLoader(project).read("lib.scm")).toBe(`(define greeting "v1")`);
    expect(await pinned.read("lib.scm")).toBe(`(define greeting "v0")`);
  });

  it("rejects a file created after the snapshot (not in the pinned set)", async () => {
    const project = fresh();
    project.addFile("a.scm", `(define a 1)`);
    const set = project.captureVersionSet(); // only a.scm
    project.addFile("late.scm", `(define late 9)`); // born after the snapshot

    const pinned = makeProjectLoader(project, set);
    await expect(async () => pinned.read("late.scm")).rejects.toThrow(/created after this run started/);
  });

  it("an empty versionSet still pins (rejects every require) — distinct from absent", async () => {
    const project = fresh();
    project.addFile("a.scm", `(define a 1)`);
    const pinned = makeProjectLoader(project, new Map());
    await expect(async () => pinned.read("a.scm")).rejects.toThrow(/created after this run started/);
  });
});

describe("Project.invoke — records the version-set snapshot", () => {
  it("stores the whole-project version-set on the Run, with the entry pinned too", async () => {
    const project = fresh();
    project.addFile("lib.scm", `(define (tag) "lib-v0")`); // version 0
    project.addFile(
      "main.scm",
      `(require "lib.scm")
       (define (go) (tag))`,
    ); // version 0
    const lib = project.findFile("lib.scm")!;
    project.transact(() => lib.publish(`(define (tag) "lib-v1")`)); // version 1

    const run = project.invoke({ id: "i1", file: "main.scm", name: "go", args: [] });
    // The snapshot covers BOTH files at their latest-at-invoke index.
    expect(run.versionSet.get("main.scm")).toBe(0);
    expect(run.versionSet.get("lib.scm")).toBe(1);
    // The entry's own pin agrees with the set.
    expect(run.versionIndex).toBe(run.versionSet.get("main.scm"));

    await waitFor(() => run.status !== "pending");
    expect(run.status).toBe("resolved");
    expect((run.output as RunResult).value).toBe("lib-v1"); // saw lib at v1, the latest-at-invoke
  });

  it("a library edit AFTER invoke does not change what an in-flight-pinned run replays", async () => {
    const project = fresh();
    project.addFile("lib.scm", `(define (tag) "original")`);
    project.addFile(
      "main.scm",
      `(require "lib.scm")
       (define (go) (tag))`,
    );
    const lib = project.findFile("lib.scm")!;

    // Invoke captures the snapshot (lib @ version 0)…
    const run = project.invoke({ id: "i2", file: "main.scm", name: "go", args: [] });
    await waitFor(() => run.status !== "pending");
    expect((run.output as RunResult).value).toBe("original");

    // …then the library is rewritten. The recorded snapshot must still point at v0.
    project.transact(() => lib.publish(`(define (tag) "rewritten")`));
    expect(run.versionSet.get("lib.scm")).toBe(0);
  });
});

describe("Project.runHypothesis — multi-file replay determinism (the A7 headline)", () => {
  it("replays a (require)d library at the run's pinned version, NOT the latest", async () => {
    const project = fresh();
    // The library a helper depends on. The entry calls it through a require.
    project.addFile("lib.scm", `(define (label) "from-lib-v0")`); // version 0
    project.addFile(
      "main.scm",
      `(require "lib.scm")
       (define (run) (label))`,
    );

    const run = project.invoke({ id: "r", file: "main.scm", name: "run", args: [] });
    await waitFor(() => run.status !== "pending");
    expect((run.output as RunResult).value).toBe("from-lib-v0");

    // Now edit BOTH the entry and the required library to new versions.
    const main = project.findFile("main.scm")!;
    const lib = project.findFile("lib.scm")!;
    project.transact(() => {
      lib.publish(`(define (label) "from-lib-v1")`); // lib version 1
      main.publish(`(require "lib.scm")\n(define (run) (string-append "EDITED " (label)))`); // main version 1
    });

    // Replay with no tweaks. Before A7, the entry pinned to v0 but `(require)`d
    // lib.scm read latest (v1) → "from-lib-v1" (a tear). With the version-set,
    // both entry AND library replay at the original cut.
    const { hypothesis, finished } = project.runHypothesis({ id: "h", run, tweaks: new Map() });
    const v = await finished;
    expect(v).toBe("from-lib-v0"); // deterministic: original entry + original library
    expect(hypothesis.status).toBe("resolved");
  });

  it("a transitive require (entry → mid → base) replays every level at its pinned version", async () => {
    const project = fresh();
    project.addFile("base.scm", `(define base-val "base-v0")`);
    project.addFile("mid.scm", `(require "base.scm")\n(define (mid) base-val)`);
    project.addFile("main.scm", `(require "mid.scm")\n(define (run) (mid))`);

    const run = project.invoke({ id: "r", file: "main.scm", name: "run", args: [] });
    await waitFor(() => run.status !== "pending");
    expect((run.output as RunResult).value).toBe("base-v0");

    // Bump the DEEPEST file. The pinned snapshot must keep replaying base-v0.
    const base = project.findFile("base.scm")!;
    project.transact(() => base.publish(`(define base-val "base-v1")`));

    const { finished } = project.runHypothesis({ id: "h", run, tweaks: new Map() });
    expect(await finished).toBe("base-v0"); // transitive pin holds
  });
});
