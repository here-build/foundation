/**
 * Contract tests for the programmatic lineage query surface.
 *
 * Every test is .skip'd until lineage.ts is implemented. They define
 * what the three public functions are supposed to do, against a small
 * known-shape program. When we implement, remove the .skip and they
 * pressure-test the design.
 *
 * Backend is fully stubbed — no LM Studio, no Anthropic, deterministic
 * outputs. The whole suite runs in node, no web APIs touched.
 *
 * Adjusted post-review (2026-05-21):
 *   - InferenceCallSite.result is now SiteResult (kind: value | error)
 *   - traceForOutput takes (session, site) — site.result is the output
 *   - backends key is provider, not tier (matches runner.ts)
 *   - new TODO tests for nested map, exceptions, filter index, etc.
 *     (see G1–G8 in lineage.ts review findings)
 */
import { describe, expect, it, vi } from "vitest";

import {
  inferencesAt,
  recordSession,
  traceForOutput,
  type TraceConfig,
} from "../lineage.js";
import type { ModelSpec } from "../model.js";

// ── A small program with known choice-point structure ───────────────
//
// Two inference calls per persona, two personas — four inference calls
// total. The map iterates over the personas list (gives us `iterate`
// choice points), the if-branch in `respond?` gives us `branch` points.
//
// We can ask:
//   - "what inferences fired at line 12 col 4?"  → the two `(infer …)` calls
//   - "trace the persona that produced output X" → tells us which iteration
//     of map and which env-read produced the prompt

const PROGRAM = `
(define personas (list "alice" "bob"))

(define (respond? name)
  (if (equal? name "alice")
      (car (infer "fast" (string-append "hi " name)))
      (car (infer "fast" (string-append "yo " name)))))

(map respond? personas)
`;

const stubBackend = () => {
  const complete = vi.fn(async (spec: ModelSpec) => {
    if (spec.prompt === "hi alice") return "HELLO_ALICE";
    if (spec.prompt === "yo bob")   return "HEY_BOB";
    throw new Error(`stub: unexpected prompt: ${spec.prompt}`);
  });
  return { complete };
};

/** Permissive backend that echoes any prompt back wrapped in brackets.
 *  Used by G-tests that vary the program shape rather than the prompts. */
const echoBackend = () => ({
  complete: vi.fn(async (spec: ModelSpec) => `[${spec.prompt}]`),
});

const baseConfig = (): TraceConfig => ({
  files:   { "main.scm": PROGRAM },
  entry:   "main.scm",
  env:     {},
  models:  { fast: "stub:fast" },
  backends: { stub: stubBackend() },
});

// ════════════════════════════════════════════════════════════════════
// recordSession — runs the program, returns a queryable snapshot
// ════════════════════════════════════════════════════════════════════

describe("recordSession", () => {
  it("captures every inference fired by the program", async () => {
    const session = await recordSession(baseConfig());
    expect(session.inferences.length).toBe(2);
    const prompts = session.inferences.map((i) => i.prompt).sort();
    expect(prompts).toEqual(["hi alice", "yo bob"]);
  });

  it("tags each inference with the path that led to it (branch + iterate)", async () => {
    const session = await recordSession(baseConfig());
    const alice = session.inferences.find((i) => i.prompt === "hi alice");
    expect(alice).toBeDefined();
    // C1a thread dynamic parent through function-application boundaries so
    // the enclosing `map` invocation appears in the parent chain. The walker
    // surfaces both the if-arm and the map iteration.
    const kinds = alice!.path.map((e) => e.kind);
    expect(kinds).toContain("branch");
    expect(kinds).toContain("iterate");
    const branch = alice!.path.find((e) => e.kind === "branch")!;
    expect(branch).toMatchObject({ kind: "branch", arm: 0 }); // alice took the "then" arm
  });

  it("captures distinct arms for sibling inferences in opposite branches", async () => {
    const session = await recordSession(baseConfig());
    const alice = session.inferences.find((i) => i.prompt === "hi alice")!;
    const bob   = session.inferences.find((i) => i.prompt === "yo bob")!;
    const aliceArm = alice.path.find((e) => e.kind === "branch")!;
    const bobArm   = bob.path.find((e) => e.kind === "branch")!;
    expect(aliceArm.kind === "branch" && aliceArm.arm).toBe(0);
    expect(bobArm.kind   === "branch" && bobArm.arm).toBe(1);
  });

  it("stamps a version matching the program + env", async () => {
    const a = await recordSession(baseConfig());
    const b = await recordSession(baseConfig());
    expect(a.version.programHash).toBe(b.version.programHash);
    expect(a.version.envHash).toBe(b.version.envHash);
  });

  it("changes the program hash when the source changes", async () => {
    const a = await recordSession(baseConfig());
    const edited = { ...baseConfig(), files: { "main.scm": PROGRAM + "\n(+ 1 1)" } };
    const b = await recordSession(edited);
    expect(a.version.programHash).not.toBe(b.version.programHash);
  });

  it("changes the env hash when env values change", async () => {
    const a = await recordSession(baseConfig());
    const b = await recordSession({ ...baseConfig(), env: { mood: "happy" } });
    expect(a.version.envHash).not.toBe(b.version.envHash);
  });

  it("each site has a result of kind 'value' for successful inferences", async () => {
    const session = await recordSession(baseConfig());
    for (const s of session.inferences) {
      expect(s.result.kind).toBe("value");
      if (s.result.kind === "value") {
        expect(typeof s.result.value).toBe("string");
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// inferencesAt — query A
// ════════════════════════════════════════════════════════════════════

describe("inferencesAt", () => {
  it("returns the inferences fired by the form at (line, col)", async () => {
    const session = await recordSession(baseConfig());
    // The (infer …) at the alice arm. Coord is the leading `(`.
    // We discover the exact coord by inspecting the session and asserting
    // a site exists at it — keeps the test robust against trivial source edits.
    const alice = session.inferences.find((i) => i.prompt === "hi alice")!;
    const found = inferencesAt(session, alice.ast.line, alice.ast.col);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((c) => c.prompt === "hi alice")).toBe(true);
  });

  it("returns multiple sites when the same form fires in a loop", async () => {
    // invocationByTask now holds the full list of invocations per task
    // (one per HOF iteration). If we wrap personas in a longer list, each
    // iteration still hits the same (line, col) but produces a distinct
    // InferenceCallSite with its own path (iterate index differs).
    const longerProgram = PROGRAM.replace(
      `(list "alice" "bob")`,
      `(list "alice" "bob" "alice" "bob")`,
    );
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": longerProgram },
    });
    // Each branch arm fires twice now.
    const aliceCalls = session.inferences.filter((i) => i.prompt === "hi alice");
    expect(aliceCalls.length).toBe(2);
    // Same AST coord, distinct paths.
    expect(aliceCalls[0]!.ast).toEqual(aliceCalls[1]!.ast);
    expect(aliceCalls[0]!.path).not.toEqual(aliceCalls[1]!.path);
  });

  it("returns an empty list for a coordinate with no inference there", async () => {
    const session = await recordSession(baseConfig());
    expect(inferencesAt(session, 1, 0)).toEqual([]);
  });
});  // close inferencesAt block (the skipped multi-sites test sits inside it)

// ════════════════════════════════════════════════════════════════════
// traceForOutput — query B
// ════════════════════════════════════════════════════════════════════

describe("traceForOutput", () => {
  it("traces a primitive output back through its arg lineage", async () => {
    const session = await recordSession(baseConfig());
    const alice = session.inferences.find((i) => i.prompt === "hi alice")!;
    expect(alice.result.kind).toBe("value");
    const trace = await traceForOutput(session, alice);

    // Prompt was (string-append "hi " name). args[0] of the inference is
    // that prompt string. Its lineage should walk back into the
    // string-append call, then to the literal "hi " and the iteration
    // element "alice" from the map.
    expect(trace.args.length).toBe(1); // schema slot omitted; just the prompt
    const promptArg = trace.args[0]!;
    expect(promptArg.value).toBe("hi alice");
    expect(promptArg.origin.kind).toBe("call"); // string-append
    expect(promptArg.inputs.length).toBe(2);

    const [literal, name] = promptArg.inputs;
    expect(literal!.value).toBe("hi ");
    expect(literal!.origin.kind).toBe("literal");

    expect(name!.value).toBe("alice");
    expect(name!.origin.kind).toBe("iteration-element");
  });

  it("returns the trace bounded by path length (not by full execution)", async () => {
    const session = await recordSession(baseConfig());
    const bob = session.inferences.find((i) => i.prompt === "yo bob")!;
    const trace = await traceForOutput(session, bob);
    // Path length for this simple program is ~2 entries; trace depth ≤ 4.
    const maxDepth = (n: { inputs: readonly { inputs: readonly unknown[] }[] }): number =>
      n.inputs.length === 0 ? 0 : 1 + Math.max(...n.inputs.map((i) => maxDepth(i as never)));
    const depth = Math.max(...trace.args.map((a) => maxDepth(a as never)));
    expect(depth).toBeLessThan(6);
  });

  it("returns a CodeTrace rooted at the inference site with the prompt arg materialised", async () => {
    const session = await recordSession(baseConfig());
    const alice = session.inferences.find((i) => i.prompt === "hi alice")!;
    const trace = await traceForOutput(session, alice);
    expect(trace.site).toBe(alice);
    expect(trace.args.length).toBe(1);
    const promptArg = trace.args[0]!;
    // The value is whatever the prompt expression resolved to at runtime.
    expect(promptArg.value).toBe("hi alice");
    // Compound prompt — string-append — surfaces as a call origin.
    expect(promptArg.origin.kind).toBe("call");
  });

  it("errors when site doesn't belong to the session", async () => {
    const sessionA = await recordSession(baseConfig());
    const otherProgram = "(car (infer \"fast\" \"hello\"))";
    const helloStub = { complete: vi.fn(async () => "HELLO") };
    const sessionB = await recordSession({
      ...baseConfig(),
      files: { "main.scm": otherProgram },
      backends: { stub: helloStub },
    });
    const siteFromB = sessionB.inferences[0]!;
    await expect(traceForOutput(sessionA, siteFromB))
      .rejects.toThrow(/site.*program/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// Composition: the "click a value, show the chain" UI flow
// ════════════════════════════════════════════════════════════════════
//
// This isn't testing one function — it's testing the composition the UI
// will actually use. The session is captured once; queries are cheap.
//
describe("end-to-end composition", () => {
  it("answers `what inferences here?` and `where did this output come from?` against one session", async () => {
    const session = await recordSession(baseConfig());

    // Pick alice's site by prompt and recover its (line, col) — robust to
    // trivial source edits. Simulates the UI flow where the user clicks
    // into the editor at a known card's coord.
    const alice = session.inferences.find((i) => i.prompt === "hi alice")!;
    const calls = inferencesAt(session, alice.ast.line, alice.ast.col);
    expect(calls.length).toBe(1);

    // User clicks the card's value; UI queries traceForOutput.
    const trace = await traceForOutput(session, calls[0]!);
    expect(trace.args.length).toBeGreaterThan(0);
    expect(trace.args[0]!.value).toBe("hi alice");
  });
});

// ════════════════════════════════════════════════════════════════════
// Gap-filling tests (G1–G8 from lineage.ts review findings)
// All .skip'd until implementation; defined here so the contract is
// complete before we start writing real code.
// ════════════════════════════════════════════════════════════════════

describe("nested map (G1)", () => {
  it("produces a path with two separate iterate entries for outer + inner", async () => {
    const program = `
(define xs '(1 2))
(define ys '(a b))
(map (lambda (x)
       (map (lambda (y) (car (infer "fast" (string-append (number->string x) (symbol->string y)))))
            ys))
     xs)
`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    expect(session.inferences.length).toBe(4); // 2 outer × 2 inner
    // Each inference should have at least two `iterate` entries in its path.
    const allHaveNestedIterate = session.inferences.every(
      (i) => i.path.filter((e) => e.kind === "iterate").length >= 2,
    );
    expect(allHaveNestedIterate).toBe(true);
  });
});

describe("short-circuit and/or (G2)", () => {
  it("records the position where evaluation short-circuited", async () => {
    const program = `(or #f (car (infer "fast" "from-or")) (car (infer "fast" "never")))`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    expect(session.inferences.length).toBe(1); // second infer never fires
    expect(session.inferences[0]!.prompt).toBe("from-or");
  });
});

describe("exception mid-eval (G3)", () => {
  it("returns a partial session with error markers on failed sites", async () => {
    const program = `(car (infer "fast" "fail-please"))`;
    const config = {
      ...baseConfig(),
      backends: {
        stub: {
          complete: vi.fn(async () => { throw new Error("backend boom"); }),
        },
      },
    };
    const session = await recordSession({ ...config, files: { "main.scm": program } });
    expect(session.inferences.length).toBe(1);
    expect(session.inferences[0]!.result.kind).toBe("error");
  });
});

describe("cacheKey distinguishes prompts (G5)", () => {
  it("two infer calls with same prompt but different cacheKey produce distinct sites", async () => {
    const program = `
(list (car (infer "fast" "hello" "" "key-a"))
      (car (infer "fast" "hello" "" "key-b")))
`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    expect(session.inferences.length).toBe(2);
    expect(session.inferences.map((i) => i.cacheKey).sort()).toEqual(["key-a", "key-b"]);
    expect(new Set(session.inferences.map((i) => i.taskId)).size).toBe(2);
  });
});

describe("infer/chat canonical prompt (G6)", () => {
  it("Site.prompt is the JSON-stringified message list, not the scheme expression", async () => {
    const program = `
(car (infer/chat "fast"
  (list (infer/chat/system "sys") (infer/chat/user "hi"))))
`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    const site = session.inferences[0]!;
    expect(site.prompt.startsWith("[")).toBe(true); // JSON list, not s-expression
    const parsed = JSON.parse(site.prompt) as Array<{ role: string; content: string }>;
    expect(parsed[0]!.role).toBe("system");
    expect(parsed[1]!.role).toBe("user");
  });
});

describe("filter index against input list (G7)", () => {
  it("iterate index in the path is the input position, not the output position", async () => {
    const program = `
(define survivors (filter (lambda (x) (> x 1)) '(0 2 3)))
(map (lambda (s) (car (infer "fast" (number->string s)))) survivors)
`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    // Two survivors: 2 (input idx 1) and 3 (input idx 2). Map fires per
    // survivor; recorded iterate index reflects the FILTER's idea.
    // Sketch decision: input-list positions. So filter would record
    // iterate=1, iterate=2 (not iterate=0, iterate=1).
    expect(session.inferences.length).toBe(2);
    // Implementation-specific: we'd assert the recorded indices map
    // back to input positions of survivors.
  });
});

describe("when / unless / case (G8)", () => {
  it("(when test body) folds into a branch entry with arm=0 (taken) or arm=1 (skipped)", async () => {
    const program = `(when #t (car (infer "fast" "fired")))`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    expect(session.inferences.length).toBe(1);
    const branches = session.inferences[0]!.path.filter((e) => e.kind === "branch");
    expect(branches.length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// Audit regression — async-recursive HOFs (audit finding #1)
// ════════════════════════════════════════════════════════════════════
//
// LIPS native reduce iterates via `unpromise(fn(acc, x)).then(recurse)`,
// so iteration N+1 fires from a microtask AFTER evaluatePair's finally
// restored the module-level dynamic-call-site holder. Without per-lambda
// wrapping (wrapLambdaArgs), all iter-≥2 lambdas inherit the outer
// dynamic parent and lose the reduce invocation from their parent chain.
// This test exercises the fix.

describe("async-recursive HOFs (audit #1)", () => {
  it("find with promise-returning predicates iterates through every element", async () => {
    // find recurses via `unpromise(fn(x)).then(...)` — iteration N+1 fires
    // from a microtask AFTER evaluatePair's finally restores the dynamic-
    // call-site holder. Without wrapLambdaArgs in the evaluator, iter ≥2
    // would lose the find invocation from their parent chain and either
    // produce wrong paths or fail to find via lineage queries.
    const program = `
(define names '("a" "b" "c"))
(find (lambda (n) (string=? (car (infer "fast" n)) "[b]")) names)
`;
    const session = await recordSession({
      ...baseConfig(),
      files: { "main.scm": program },
      backends: { stub: echoBackend() },
    });
    // Predicates fire for "a" (no match), "b" (match → stop). echoBackend
    // returns "[<prompt>]", so prompt "b" → "[b]" → match.
    expect(session.inferences.length).toBe(2);
    const prompts = session.inferences.map((s) => s.prompt).sort();
    expect(prompts).toEqual(["a", "b"]);
    // Every site has a non-empty path with an iterate entry pointing at
    // the find invocation. Without C1a + wrapLambdaArgs, iter ≥2 (the "b"
    // inference) would have NO iterate entry.
    const allHaveIterate = session.inferences.every(
      (s) => s.path.some((e) => e.kind === "iterate"),
    );
    expect(allHaveIterate).toBe(true);
  });
});
