/**
 * Bouncer triage: per-bouncer parallel LM call deciding whether the
 * persona is audience-mismatch (category-level rejection) or latent-fit
 * (would convert with better wording).
 *
 * Default-verdict-bias pattern — the system prompt anchors mismatch=false
 * as the default and requires explicit category-rejection evidence to
 * flip. The stub here drives both branches deterministically; live
 * behaviour gets validated by experiment, not unit test.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRegistry } from "../registry.js";

const PROGRAM_PREAMBLE = `
(define TriageSchema
  (s/object
    (s/field/boolean "mismatch" "true only with explicit category-rejection evidence; default false")
    (s/field/string  "reason"   "one-line why this verdict")))

(define (bouncing? v) (equal? v "bounce"))

(define (triage-one persona reaction tagline)
  (let ((v (car (infer/chat "high"
                  (list (infer/chat/system "stub-triage-system")
                        (infer/chat/user
                          (string-append "TRIAGE|" persona "|"
                                         (field reaction "verdict") "|"
                                         (field reaction "concern") "|" tagline)))
                  TriageSchema
                  (string-append "triage/" tagline "/" persona)))))
    (dict "persona"  persona
          "reaction" reaction
          "mismatch" (field v "mismatch")
          "reason"   (field v "reason"))))

;; Triage runs only over bouncers — clickers are kept as-is, not analysed.
;; Fold-with-conditional-cons: no '()-as-sentinel inside the result list.
(define (triage-bouncers personas reactions tagline)
  (reduce (lambda (pr acc)
            (let ((p (car pr)) (r (cadr pr)))
              (if (bouncing? (field r "verdict"))
                  (cons (triage-one p r tagline) acc) acc)))
          '() (map list personas reactions)))

(define (mismatched-of triaged)
  (filter (lambda (t) (equal? (field t "mismatch") #t)) triaged))

(define (unsatisfied-of triaged)
  (filter (lambda (t) (equal? (field t "mismatch") #f)) triaged))
`;

/** Stub: triage verdicts keyed by persona-id (proxy for LM judgement). */
const triageStub = (
  verdicts: Record<string, { mismatch: boolean; reason: string }>,
) => {
  const complete = vi.fn(async (spec: ModelSpec) => {
    const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = parsed.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("TRIAGE|")) {
      const [, persona] = user.split("|");
      const v = verdicts[persona!];
      if (!v) throw new Error(`stub: no triage verdict for ${persona}`);
      return v;
    }
    throw new Error(`stub: unexpected prompt: ${user}`);
  });
  return { complete };
};

describe("triage-bouncers — mismatch vs latent fit split", () => {
  it("calls LM once per bouncer; skips clickers; splits cleanly", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // 4 personas, 4 reactions:
    //   p1 click  — no triage
    //   p2 bounce — category rejection → mismatch=true
    //   p3 bounce — clarity issue       → mismatch=false (latent fit)
    //   p4 bounce — category rejection → mismatch=true
    const backend = triageStub({
      p2: { mismatch: true,  reason: "rejects no-code category outright" },
      p3: { mismatch: false, reason: "wording too vague to evaluate" },
      p4: { mismatch: true,  reason: "rejects JS as a foundation" },
    });

    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry(backend), signal: ac.signal }).done;

    const out = (await project.run(`
${PROGRAM_PREAMBLE}
(define personas  (list "p1" "p2" "p3" "p4"))
(define reactions (list
  (dict "verdict" "click"  "concern" "looks promising")
  (dict "verdict" "bounce" "concern" "no-code is snake oil")
  (dict "verdict" "bounce" "concern" "I don't know what this does")
  (dict "verdict" "bounce" "concern" "JS-based, hard pass")))

(define triaged (triage-bouncers personas reactions "hero text v0"))
(list (length triaged)
      (length (mismatched-of triaged))
      (length (unsatisfied-of triaged)))
`)) as [number, number, number];

    // 3 bouncers triaged, 2 mismatch, 1 latent-fit
    expect(out).toEqual([3, 2, 1]);
    expect(backend.complete).toHaveBeenCalledTimes(3);

    ac.abort(); await draining;
  });

  it("returns empty lists when no one bounced", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const backend = triageStub({});
    const ac = new AbortController();
    const draining = startOrchestrator({ project, cache, backends: singletonRegistry(backend), signal: ac.signal }).done;

    const out = (await project.run(`
${PROGRAM_PREAMBLE}
(define personas  (list "p1" "p2"))
(define reactions (list
  (dict "verdict" "click" "concern" "")
  (dict "verdict" "click" "concern" "")))
(define triaged (triage-bouncers personas reactions "t0"))
(list (length triaged) (length (mismatched-of triaged)) (length (unsatisfied-of triaged)))
`)) as [number, number, number];

    expect(out).toEqual([0, 0, 0]);
    expect(backend.complete).toHaveBeenCalledTimes(0);

    ac.abort(); await draining;
  });

  it("replays the same triage result without backend calls (cache hit)", async () => {
    const PROGRAM = `
${PROGRAM_PREAMBLE}
(define personas  (list "p1" "p2"))
(define reactions (list
  (dict "verdict" "bounce" "concern" "no-code is snake oil")
  (dict "verdict" "bounce" "concern" "wording too vague")))
(triage-bouncers personas reactions "t0")
`;
    const verdicts = {
      p1: { mismatch: true,  reason: "rejects no-code category" },
      p2: { mismatch: false, reason: "could be reached with clearer copy" },
    };
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const b1 = triageStub(verdicts);
    const ac1 = new AbortController();
    const d1 = startOrchestrator({ project, cache, backends: singletonRegistry(b1), signal: ac1.signal }).done;
    const first = await project.run(PROGRAM);
    expect(b1.complete).toHaveBeenCalledTimes(2);
    ac1.abort(); await d1;

    const b2 = triageStub(verdicts);
    const ac2 = new AbortController();
    const d2 = startOrchestrator({ project, cache, backends: singletonRegistry(b2), signal: ac2.signal }).done;
    const second = await project.run(PROGRAM);
    expect(b2.complete).toHaveBeenCalledTimes(0);
    expect(second).toEqual(first);
    ac2.abort(); await d2;
  });
});
