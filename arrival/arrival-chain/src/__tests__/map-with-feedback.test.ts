/**
 * Map-with-feedback: parallel critique → filter failures → parallel rewrite.
 *
 * The full pipeline (including a generate-question wave) lives in the
 * .scm sample. This test exercises the critique → filter → rewrite
 * loop with pre-supplied questions to keep the substrate scope tight
 * — see SUBSTRATE NOTE below for why we don't chain generate→critique
 * directly through a let-binding in tests yet.
 */
import { describe, expect, it, vi } from "vitest";
import { singletonRouter } from "@here.build/arrival-inference";

import { runPipeline } from "../runner.js";
import type { ModelSpec } from "@here.build/arrival-inference";
import { parseChatPrompt } from "@here.build/arrival-inference";

// SUBSTRATE NOTE: chaining `(let ((q (infer ...))) (infer ... q))` so the
// inner infer sees the OUTER's resolved value goes through arrival-
// scheme's promise-aware evaluator. Whether `q` carries the resolved
// string or the Promise as-the-value depends on context; in some
// nesting shapes the promise reaches the next rosetta call un-forced
// and the inner call sees "[object Promise]" as content. For pipelines
// without nested-infer chains this isn't an issue (see cross-
// fertilization, refine-until, enrich-distant). The sample .scm
// includes the full multi-wave pipeline; arrival-scheme work to make
// nested-infer always force at boundaries lands separately.

const PROGRAM = `
(define questions (require "questions.json"))  ;; → questions, list of strings

(define MomTestSchema
  (s/object (s/field/boolean "specific") (s/field/string "fix")))

(define QuestionSchema
  (s/object (s/field/string "question")))

(define (critique q)
  (car (infer/chat "fast"
         (list (infer/chat/system "critique") (infer/chat/user q))
         MomTestSchema q)))

(define (rewrite p)
  (let ((original (car p)) (verdict (car (cdr p))))
    (car (infer/chat "strong"
           (list (infer/chat/system "rewrite")
                 (infer/chat/user (string-append "Original: " original " Fix: " (:fix verdict))))
           QuestionSchema original))))

(define (passes? p) (equal? (:specific (car (cdr p))) #t))

(define pairs (map (lambda (q) (list q (critique q))) questions))
(define passing (filter passes? pairs))
(define failing (filter (lambda (p) (not (passes? p))) pairs))
(define rewritten (map rewrite failing))

(list (list "passed" (map car passing))
      (list "rewritten" (map (lambda (q) (:question q)) rewritten)))
`;

const routedBackend = () => {
  const calls = { critique: 0, rewrite: 0 };
  const complete = vi.fn(async (spec: ModelSpec) => {
    const msgs = parseChatPrompt(spec.prompt) ?? [];
    const system = msgs.find((m) => m.role === "system")?.content ?? "";
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    if (system === "critique") {
      calls.critique++;
      const m = user.match(/q-(\d+)/);
      const i = m ? Number(m[1]) : 0;
      return {
        value:
          i % 2 === 0
            ? { specific: false, fix: `tighter version of q-${i}` }
            : { specific: true, fix: "" },
      };
    }
    if (system === "rewrite") {
      calls.rewrite++;
      const m = user.match(/q-(\d+)/);
      const i = m ? Number(m[1]) : 0;
      return { value: { question: `q-${i}-tight` } };
    }
    throw new Error(`unexpected system: ${system}`);
  });
  return { complete, calls };
};

describe("map-with-feedback — parallel critique → filter → parallel rewrite", () => {
  it("retries only the failing items, replays cleanly", async () => {
    const backend = routedBackend();
    const result = await runPipeline({
      files: {
        "questions.json": JSON.stringify(["q-0", "q-1", "q-2", "q-3"]),
        "main.scm": PROGRAM,
      },
      entry: "main.scm",
      router: singletonRouter(backend),
    });

    expect(backend.calls.critique).toBe(4);
    expect(backend.calls.rewrite).toBe(2);

    const r = result as [string, string[]][];
    expect(r[0][0]).toBe("passed");
    expect(r[1][0]).toBe("rewritten");
    expect(r[0][1].sort()).toEqual(["q-1", "q-3"]);
    expect(r[1][1].sort()).toEqual(["q-0-tight", "q-2-tight"]);
  });
});
