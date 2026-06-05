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
import { createInferStore } from "../infer-store.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { singletonRouter } from "../registry.js";

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
                                         (:verdict reaction) "|"
                                         (:concern reaction) "|" tagline)))
                  TriageSchema
                  (string-append "triage/" tagline "/" persona)))))
    (dict "persona"  persona
          "reaction" reaction
          "mismatch" (:mismatch v)
          "reason"   (:reason v))))

;; Triage runs only over bouncers — clickers are kept as-is, not analysed.
;; Fold-with-conditional-cons: no '()-as-sentinel inside the result list.
(define (triage-bouncers personas reactions tagline)
  (reduce (lambda (pr acc)
            (let ((p (car pr)) (r (cadr pr)))
              (if (bouncing? (:verdict r))
                  (cons (triage-one p r tagline) acc) acc)))
          '() (map list personas reactions)))

(define (mismatched-of triaged)
  (filter (lambda (t) (equal? (:mismatch t) #t)) triaged))

(define (unsatisfied-of triaged)
  (filter (lambda (t) (equal? (:mismatch t) #f)) triaged))
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
      return { value: v };
    }
    throw new Error(`stub: unexpected prompt: ${user}`);
  });
  return { complete };
};

describe("triage-bouncers — mismatch vs latent fit split", () => {
  it("calls LM once per bouncer; skips clickers; splits cleanly", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
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

    project.bindInfer(createInferStore(singletonRouter(backend)));

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

  });

  it("returns empty lists when no one bounced", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const backend = triageStub({});
    project.bindInfer(createInferStore(singletonRouter(backend)));

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
    const b1 = triageStub(verdicts);
    project.bindInfer(createInferStore(singletonRouter(b1)));
    const first = await project.run(PROGRAM);
    expect(b1.complete).toHaveBeenCalledTimes(2);

    // Replay over the same store: every content tuple hits its existing cell,
    // so no further backend calls fire.
    const second = await project.run(PROGRAM);
    expect(b1.complete).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });
});
