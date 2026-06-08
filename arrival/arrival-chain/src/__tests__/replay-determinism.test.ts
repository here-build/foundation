/**
 * replay-determinism (E2, adversarial) — the warrant behind "the trace is the
 * product" is that REPLAY is deterministic EVEN WHEN the world underneath has
 * drifted. The happy-path `effect-log.test.ts` proves replay returns recorded
 * values with zero external hits; this file attacks the contract under three
 * kinds of drift that, if mishandled, would silently desync a replayed run from
 * its recorded truth:
 *
 *   1. PROGRAM CHANGED — the AST moved, but the effect's CONTENT is the same.
 *      Replay must short-circuit (the key is content-addressed, not position-
 *      addressed); and an effect whose content actually CHANGED must MISS the log
 *      and re-hit the plane (replay is per-effect, not all-or-nothing).
 *   2. MODEL TOKEN RE-POINT — the same call site now names a different model
 *      token. The effect key is `[kind, model, prompt, schema, cacheKey]`, so a
 *      re-pointed token mints a DIFFERENT key → the recorded value does NOT leak
 *      to the new token (a replay is faithful to WHAT RAN, not to "whatever the
 *      label points at now"). This is the engine-level half of the host
 *      alias-re-point property (the `aliasRewritingStore` composition half is
 *      tested host-side, where that store lives).
 *   3. DATA DRIFT — a `(sql/query)`'s underlying table changed between the record
 *      and the replay. Replay must return the RECORDED row, never the drifted
 *      live row (the whole point of a deterministic time-travel replay).
 *
 * Every assertion drives the real `Project.run` replay seam (`opts.effectLog` /
 * `opts.data` / `opts.onEffectResult`), not a reimplementation of it.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import type { DataEffect, DataEffectResolver } from "../data-effects.js";
import { effectLogCollector, inferEffectKey, sqlEffectKey, type EffectLog } from "../effect-log.js";
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";

const fresh = () => ArrivalChain.bootstrap(new Project()).root;

/** A backend that answers a fixed map of prompt→value and THROWS on any prompt it
 *  was not told about — so a replay that wrongly reaches the backend fails loudly
 *  (the test can't pass by accident). */
function scriptedBackend(answers: Record<string, unknown>) {
  const complete = vi.fn(async (s: ModelSpec) => {
    if (s.prompt in answers) return { value: answers[s.prompt] };
    throw new Error(`scriptedBackend: unexpected prompt ${JSON.stringify(s.prompt)}`);
  });
  return { complete };
}

// ── 1. PROGRAM CHANGED — content-addressed replay survives an AST edit ───────

describe("replay under a CHANGED program — keys are content-addressed, not position-addressed", () => {
  it("a recorded effect replays even though the surrounding program was rewritten", async () => {
    // Record against program V1: two infers, assembled one way.
    const recProject = fresh();
    const backend = scriptedBackend({ p1: "one", p2: "two" });
    recProject.bindInfer(createInferStore(singletonRouter(backend)));
    const v1 = `(string-append (car (infer "m" "p1")) "+" (car (infer "m" "p2")))`;
    const collector = effectLogCollector();
    const recorded = await recProject.run(v1, { onEffectResult: collector.record });
    expect(recorded).toBe("one+two");
    expect(collector.log.size).toBe(2);

    // Replay the SAME log against a STRUCTURALLY DIFFERENT program V2 — different
    // operator, reordered, extra literal — but the two `(infer …)` content tuples
    // are byte-identical. A throwing backend proves zero external hits.
    const replayProject = fresh();
    const throwing = {
      complete: vi.fn(async () => {
        throw new Error("replay reached the backend — content key was not honored");
      }),
    };
    replayProject.bindInfer(createInferStore(singletonRouter(throwing)));
    const v2 = `(list (car (infer "m" "p2")) (car (infer "m" "p1")) "extra")`;
    const replayValue = await replayProject.run(v2, { effectLog: collector.log });
    // V2 assembles the SAME two recorded values in a new shape — both came from
    // the log (the AST changed; the content keys did not).
    expect(replayValue).toEqual(["two", "one", "extra"]);
    expect(throwing.complete).not.toHaveBeenCalled();
  });

  it("an effect whose CONTENT changed misses the log and re-hits the plane (replay is per-effect)", async () => {
    // Record p1+p2.
    const recProject = fresh();
    recProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({ p1: "one", p2: "two" }))));
    const collector = effectLogCollector();
    await recProject.run(`(string-append (car (infer "m" "p1")) "+" (car (infer "m" "p2")))`, {
      onEffectResult: collector.record,
    });

    // Replay a program where the SECOND infer's prompt drifted p2 → p2X. The first
    // replays from the log; the drifted one misses and must reach the backend.
    const replayProject = fresh();
    const liveBackend = scriptedBackend({ p2X: "two-prime" });
    replayProject.bindInfer(createInferStore(singletonRouter(liveBackend)));
    const value = await replayProject.run(`(string-append (car (infer "m" "p1")) "+" (car (infer "m" "p2X")))`, {
      effectLog: collector.log,
    });
    expect(value).toBe("one+two-prime"); // p1 from log, p2X fresh
    expect(liveBackend.complete).toHaveBeenCalledTimes(1);
    expect(liveBackend.complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: "p2X" }));
  });
});

// ── 2. MODEL TOKEN RE-POINT — the key includes the model, so a re-point misses ──

describe("replay under a model-token RE-POINT — recorded value never leaks to a different token", () => {
  it("re-pointing the model token changes the effect key → the new token re-hits the plane", async () => {
    // Record under token "fast".
    const recProject = fresh();
    recProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({ classify: "fast-said" }))));
    const collector = effectLogCollector();
    await recProject.run(`(car (infer "fast" "classify"))`, { onEffectResult: collector.record });
    // The recorded key carries the token name verbatim.
    expect([...collector.log.keys()]).toEqual([inferEffectKey("fast", "classify", null, null)]);

    // The program is edited to call "slow" instead. Binding the SAME log: the key
    // for "slow" is absent (a different model token = a different key), so replay
    // does NOT serve "fast"'s recorded value — it re-hits the plane, which answers
    // as "slow". A replay is faithful to WHAT RAN, not to the label's new target.
    const replayProject = fresh();
    const liveBackend = scriptedBackend({ classify: "slow-said" });
    replayProject.bindInfer(createInferStore(singletonRouter(liveBackend)));
    const value = await replayProject.run(`(car (infer "slow" "classify"))`, { effectLog: collector.log });
    expect(value).toBe("slow-said"); // NOT "fast-said" — no cross-token leak
    expect(liveBackend.complete).toHaveBeenCalledTimes(1);
  });

  it("replaying the ORIGINAL token still short-circuits (the re-point is the only thing that misses)", async () => {
    const recProject = fresh();
    recProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({ classify: "fast-said" }))));
    const collector = effectLogCollector();
    await recProject.run(`(car (infer "fast" "classify"))`, { onEffectResult: collector.record });

    // Same token "fast" → same key → log hit, zero external calls.
    const replayProject = fresh();
    const throwing = {
      complete: vi.fn(async () => {
        throw new Error("replay reached the backend for the original token");
      }),
    };
    replayProject.bindInfer(createInferStore(singletonRouter(throwing)));
    const value = await replayProject.run(`(car (infer "fast" "classify"))`, { effectLog: collector.log });
    expect(value).toBe("fast-said");
    expect(throwing.complete).not.toHaveBeenCalled();
  });
});

// ── 3. DATA DRIFT — replay returns the RECORDED row, not the drifted live row ──

describe("replay under SQL data drift — the recorded value wins over the changed table", () => {
  it("a (sql/query) replays its recorded rows even though the live DB has since changed", async () => {
    const program = `(@ (car (sql/query "db" "select name from users where id = $1" (list 1))) "name")`;

    // Record: the table says the user is "alice".
    const recProject = fresh();
    recProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({}))));
    const recResolver: DataEffectResolver = async (_ctx, effect: DataEffect) => {
      if (effect.kind === "sql") return [{ name: "alice" }];
      throw new Error("unexpected effect");
    };
    const collector = effectLogCollector();
    const recorded = await recProject.run(program, { data: recResolver, onEffectResult: collector.record });
    expect(recorded).toBe("alice");
    expect(collector.log.has(sqlEffectKey("db", "select name from users where id = $1", "[1]"))).toBe(true);

    // Replay: the live DB now returns "bob" (data drifted). A deterministic replay
    // MUST return the recorded "alice" — and must NOT call the live resolver at all
    // (so a drift can't even be observed). We assert both: the resolver that would
    // answer "bob" is never reached.
    const replayProject = fresh();
    replayProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({}))));
    const driftedResolver = vi.fn(async (_ctx: unknown, effect: DataEffect) => {
      if (effect.kind === "sql") return [{ name: "bob" }];
      throw new Error("unexpected effect");
    }) as unknown as DataEffectResolver;
    const replayValue = await replayProject.run(program, { data: driftedResolver, effectLog: collector.log });
    expect(replayValue).toBe("alice"); // recorded value wins over the drifted row
    expect(driftedResolver).not.toHaveBeenCalled(); // the drift is never even consulted
  });

  it("a sql whose PARAMS drifted misses the log (params are part of the key) and re-hits live", async () => {
    // Record id=1 → alice.
    const recProject = fresh();
    recProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({}))));
    const recResolver: DataEffectResolver = async (_ctx, e) => (e.kind === "sql" ? [{ name: "alice" }] : []);
    const collector = effectLogCollector();
    await recProject.run(`(@ (car (sql/query "db" "select name from users where id = $1" (list 1))) "name")`, {
      data: recResolver,
      onEffectResult: collector.record,
    });

    // Replay a program that queries id=2. The params are part of the effect key, so
    // id=2 is a DIFFERENT effect → log miss → the live resolver answers for id=2.
    const replayProject = fresh();
    replayProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({}))));
    const liveResolver = vi.fn(async (_ctx: unknown, e: DataEffect) =>
      e.kind === "sql" ? [{ name: "carol" }] : [],
    ) as unknown as DataEffectResolver;
    const value = await replayProject.run(
      `(@ (car (sql/query "db" "select name from users where id = $1" (list 2))) "name")`,
      { data: liveResolver, effectLog: collector.log },
    );
    expect(value).toBe("carol"); // id=2 is a distinct effect → fresh, not "alice"
    expect(liveResolver).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Replay is a FIXPOINT — re-recording a replay yields the same log ───────

describe("replay is idempotent — recording a replayed run reproduces the same effect-log", () => {
  it("re-collecting during replay yields a byte-identical log (the replay IS the recording)", async () => {
    const program = `(string-append (car (infer "m" "a")) "/" (car (infer "m" "b")))`;
    const recProject = fresh();
    recProject.bindInfer(createInferStore(singletonRouter(scriptedBackend({ a: "A", b: "B" }))));
    const first = effectLogCollector();
    await recProject.run(program, { onEffectResult: first.record });

    // Replay while ALSO collecting — the replayed run must emit the same key→value
    // pairs (replay records the effect sequence identically), so the log is a
    // fixpoint of record∘replay. A throwing backend guarantees zero live hits.
    const replayProject = fresh();
    replayProject.bindInfer(
      createInferStore(
        singletonRouter({
          complete: async () => {
            throw new Error("fixpoint replay reached the backend");
          },
        }),
      ),
    );
    const second = effectLogCollector();
    await replayProject.run(program, { effectLog: first.log, onEffectResult: second.record });
    expect(serialize(second.log)).toEqual(serialize(first.log));
  });
});

/** A stable, comparable serialization of an effect-log (Map → sorted entries). */
function serialize(log: EffectLog): Array<[string, string]> {
  return [...log.entries()].toSorted(([a], [b]) => a.localeCompare(b));
}
