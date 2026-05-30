/**
 * gepa-until-plateau — tail-recursive hill climb on a single candidate.
 *
 *   loop:
 *     reactions = react(tagline, personas)         ;; fan-out N
 *     score     = click-rate(reactions)            ;; in [0, 1]
 *     history+  = (cons (tagline score reactions) history)
 *     stop on: max-iter | 3-frame degrading window
 *     else:    (loop (next-tagline tagline) (+ iter 1) history+)
 *
 * The tail call is the bottom branch — arrival-scheme does TCO so iter
 * count is unbounded by the JS stack.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRouter } from "../registry.js";

const PROGRAM_PREAMBLE = `
;; take/drop/count-if/max-by live in BUILTIN_PREAMBLE.
(define (avg xs)
  (if (null? xs) 0 (/ (apply + xs) (length xs))))

;; ── stub-friendly schema (prod uses ReactionSchema with concern) ─────
(define ReactionSchema (s/object (s/field/string "verdict")))
(define NextSchema     (s/object (s/field/string "next")))

;; ── reactions / reflection over a single-string protocol stubs match ─
(define (react-cell tagline persona-id)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona-id)))
         ReactionSchema
         (string-append "react/" tagline "/" persona-id))))

(define (reactions-of tagline personas)
  (map (lambda (p) (react-cell tagline p)) personas))

;; hints = list of (tagline reach-list) — Pareto frontier so far.
;; Reflection sees current + reactions + hints, so it can synthesize
;; from "what reached which personas" in prior iterations.
;; Cache key includes hint signature so cache is correct under shifting context.
(define (hints-signature hints)
  (apply string-append
    (map (lambda (h) (string-append (car h) ":" (join "," (cadr h)) ";"))
         hints)))

(define (next-tagline current hints)
  (field (car (infer/chat "fast"
                (list (infer/chat/system "stub")
                      (infer/chat/user (string-append "REFLECT|" current "|" (hints-signature hints))))
                NextSchema
                (string-append "reflect/" current "/" (hints-signature hints))))
         "next"))

;; ── scoring ──────────────────────────────────────────────────────────
(define (clicking? v) (or (equal? v "click") (equal? v "keep-reading")))
(define (click-rate reactions)
  (let ((n (length reactions)))
    (if (= n 0) 0
        (/ (count-if (lambda (r) (clicking? (field r "verdict"))) reactions) n))))

;; ── plateau detection: 3-frame rolling window ────────────────────────
;; recent-3 vs prior-3, stop if (recent - prior) < delta.
;; entry = (tagline score reactions) — cadr/caddr access the 2nd/3rd slot.
(define (entry-score e) (cadr e))
(define (entry-reactions e) (caddr e))
(define (degrading? history delta)
  (cond ((< (length history) 6) #f)
        (else
         (< (- (avg (map entry-score (take 3 history)))
               (avg (map entry-score (take 3 (drop 3 history)))))
            delta))))

;; ── the loop ─────────────────────────────────────────────────────────
(define (best-of history) (max-by entry-score history))

;; Extract the Pareto frontier from history + inherited hints:
;;   (tagline reach) where reach is the list of personas who clicked it.
;; Inherited hints come from a parent worklist task; we union them in.
;;
;; clickers-of folds the (persona, reaction) zip into an acc of clicker
;; ids — no '()-as-sentinel inside a string-list.
(define (clickers-of personas reactions)
  (reduce (lambda (pr acc)
            (if (clicking? (field (cadr pr) "verdict"))
                (cons (car pr) acc) acc))
          '() (map list personas reactions)))

(define (frontier-of history personas inherited-hints)
  (append inherited-hints
    (map (lambda (e) (list (car e) (clickers-of personas (entry-reactions e))))
         history)))

(define (gepa-until-plateau initial personas max-iter plateau-delta inherited-hints)
  (define (loop tagline iter history)
    (let* ((reactions (reactions-of tagline personas))
           (score     (click-rate reactions))
           (entry     (list tagline score reactions))
           (history+  (cons entry history))
           (hints     (frontier-of history+ personas inherited-hints)))
      (cond
        ((>= iter max-iter)                  (best-of history+))
        ((degrading? history+ plateau-delta) (best-of history+))
        (else
         (loop (next-tagline tagline hints) (+ iter 1) history+)))))    ; tail call
  (loop initial 0 '()))
`;

/**
 * Stub: tagline → per-persona verdict, plus reflection chain "t0→t1→t2…".
 * `scores` lets each test prescribe the click-rate trajectory.
 */
const gepaStub = (
  taglineVerdicts: Record<string, Record<string, string>>,
  reflectionChain: Record<string, string>,
) => {
  const complete = vi.fn(async (spec: ModelSpec) => {
    const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = parsed.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("REACT|")) {
      const [, tagline, persona] = user.split("|");
      const verdict = taglineVerdicts[tagline!]?.[persona!];
      if (!verdict) throw new Error(`stub: no verdict for ${user}`);
      return { value: { verdict } };
    }
    if (user.startsWith("REFLECT|")) {
      const [, tagline] = user.split("|");
      const next = reflectionChain[tagline!];
      if (next === undefined) throw new Error(`stub: no reflection for ${user}`);
      return { value: { next } };
    }
    throw new Error(`stub: unexpected prompt: ${user}`);
  });
  return { complete };
};

describe("gepa-until-plateau — single-candidate hill climb", () => {
  it("stops on max-iter; returns highest-scoring tagline in history", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const personas = ["p1"];

    // Trajectory: t0 bounce, t1 click (best), t2 bounce.
    // max-iter=2 → react at iter=0,1,2 → returns t1 as the peak.
    const backend = gepaStub(
      {
        t0: { p1: "bounce" },
        t1: { p1: "click" },
        t2: { p1: "bounce" },
      },
      { t0: "t1", t1: "t2" },
    );

    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = (await project.run(`
${PROGRAM_PREAMBLE}
(gepa-until-plateau "t0" (list "p1") 2 0.05 '())
`)) as [string, number, unknown[]];

    expect(out[0]).toBe("t1");
    expect(out[1]).toBe(1);
    // 3 react × 1 persona + 2 reflect = 5 backend calls
    expect(backend.complete).toHaveBeenCalledTimes(5);

    ac.abort(); await draining;
  });

  it("stops on the 3-frame degrading window before max-iter", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    const personas = ["p1", "p2"];

    // 6 taglines, 2 personas, click-rate trajectory:
    //   t0=1.0, t1=1.0, t2=1.0, t3=0.5, t4=0.5, t5=0.5
    // After iter=5 (history has 6 entries), recent-3 = (t5,t4,t3)=0.5,
    // prior-3 = (t2,t1,t0)=1.0; delta = -0.5 < 0.05 → stop, return best=t0.
    const v = (a: string, b: string) => ({ p1: a, p2: b });
    const backend = gepaStub(
      {
        t0: v("click", "click"),
        t1: v("click", "click"),
        t2: v("click", "click"),
        t3: v("click", "bounce"),
        t4: v("click", "bounce"),
        t5: v("click", "bounce"),
      },
      { t0: "t1", t1: "t2", t2: "t3", t3: "t4", t4: "t5" },
    );

    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = (await project.run(`
${PROGRAM_PREAMBLE}
(gepa-until-plateau "t0" (list "p1" "p2") 100 0.05 '())
`)) as [string, number, unknown[]];

    // History (most-recent first) is (t5 t4 t3 t2 t1 t0) with scores
    // (0.5 0.5 0.5 1 1 1). max-by uses strict `>` and walks head→tail
    // from (car history), so the first tied-at-max it meets walking back
    // wins: that's t2 — the latest tagline that hit the peak before
    // degradation set in.
    expect(out[0]).toBe("t2");
    expect(out[1]).toBe(1);
    // 6 iters × 2 personas + 5 reflections = 17 calls; degrading triggers, loop never advances past iter=5.
    expect(backend.complete).toHaveBeenCalledTimes(6 * 2 + 5);

    ac.abort(); await draining;
  });

  it("hints from prior branches change the reflection result (frontier memory)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // The stub returns DIFFERENT next-taglines depending on whether the
    // reflection user-prompt mentions the inherited hint ("t-prior").
    // This proves: hints flow into the reflection call's user content
    // and thus into both the LM's input and the cache key.
    const v = (a: string) => ({ p1: a });
    const complete = vi.fn(async (spec: ModelSpec) => {
      const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
      const user = parsed.find((m) => m.role === "user")?.content ?? "";
      if (user.startsWith("REACT|")) {
        const [, tagline] = user.split("|");
        return { value: { verdict: tagline === "t0" ? "bounce" : "click" } };
      }
      if (user.startsWith("REFLECT|")) {
        const sawPriorHint = user.includes("t-prior:p1");
        return { value: { next: sawPriorHint ? "t-merged" : "t1" } };
      }
      throw new Error(`unexpected: ${user}`);
    });
    const backend = { complete };
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    // Pass an inherited hint: prior branch found that "t-prior" reached p1.
    // We expect reflection to synthesize "t-merged" instead of the cold "t1".
    const out = (await project.run(`
${PROGRAM_PREAMBLE}
(gepa-until-plateau "t0" (list "p1") 2 0.05
                    (list (list "t-prior" (list "p1"))))
`)) as [string, number, unknown[]];

    expect(out[0]).toBe("t-merged");

    ac.abort(); await draining;
  });

  it("continues while last-3 vs prior-3 delta stays above plateau-delta", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // Monotonic improvement: every step gains > delta, never plateaus.
    // We bound it with max-iter so the test finishes.
    const v = (a: string) => ({ p1: a });
    const backend = gepaStub(
      {
        t0: v("bounce"),
        t1: v("bounce"),
        t2: v("click"),
        t3: v("click"),
        t4: v("click"),
        t5: v("click"),
      },
      { t0: "t1", t1: "t2", t2: "t3", t3: "t4", t4: "t5" },
    );

    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = (await project.run(`
${PROGRAM_PREAMBLE}
;; max-iter=5 — stop because of iter cap, not plateau.
(gepa-until-plateau "t0" (list "p1") 5 0.05 '())
`)) as [string, number, unknown[]];

    // History (most-recent first): (t5 t4 t3 t2 t1 t0). Scores
    // (1 1 1 1 0 0). max-by walks head→tail from (car history)=t5; ties
    // never update, so the most-recent tied peak wins → t5.
    expect(out[0]).toBe("t5");
    expect(out[1]).toBe(1);
    expect(backend.complete).toHaveBeenCalledTimes(6 + 5); // 6 react × 1 + 5 reflect

    ac.abort(); await draining;
  });
});
