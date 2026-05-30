/**
 * Worklist-fold outer driver: ties the inner GEPA loop and bouncer
 * triage into a recursive tagline optimiser.
 *
 *   drive(worklist, results, total-iter):
 *     - pop task {personas, initial, parent-id, hints}
 *     - run gepa-until-plateau → best-tagline + reactions
 *     - if bounce-rate < threshold: record node, continue worklist
 *     - else: triage bouncers, push child task for the latent-fit subset
 *     - return when worklist empty OR total-iter-cap reached
 *
 * The drive is tail-recursive; results accumulate forward, tree is
 * reconstructable via parent-id links.
 *
 * Frontier memory: each child task inherits hints derived from the
 * parent's findings — the LM sees "T1 reached p1,p2 in the parent's
 * branch" when proposing the child's next tagline.
 */
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { startOrchestrator } from "../worker.js";
import { singletonRouter } from "../registry.js";
import { configScm } from "./fixtures/config-scm.js";

const PREAMBLE = `
;; take/drop/count-if/max-by live in BUILTIN_PREAMBLE.
(define (avg xs)
  (if (null? xs) 0 (/ (apply + xs) (length xs))))

;; ── schemas ────────────────────────────────────────────────────────
(define ReactionSchema (s/object (s/field/string "verdict")))
(define NextSchema     (s/object (s/field/string "next")))
(define TriageSchema   (s/object (s/field/boolean "mismatch")
                                 (s/field/string  "reason")))

;; ── inner GEPA loop ────────────────────────────────────────────────
(define (react-cell tagline persona)
  (car (infer/chat "fast"
         (list (infer/chat/system "stub")
               (infer/chat/user (string-append "REACT|" tagline "|" persona)))
         ReactionSchema
         (string-append "react/" tagline "/" persona))))

(define (reactions-of tagline personas)
  (map (lambda (p) (react-cell tagline p)) personas))

(define (clicking? v) (or (equal? v "click") (equal? v "keep-reading")))
(define (bouncing? v) (equal? v "bounce"))

(define (click-rate reactions)
  (let ((n (length reactions)))
    (if (= n 0) 0
        (/ (count-if (lambda (r) (clicking? (field r "verdict"))) reactions) n))))

;; entry = (tagline score reactions)
(define (entry-score e) (cadr e))
(define (entry-reactions e) (caddr e))

(define (degrading? history delta)
  (cond ((< (length history) 6) #f)
        (else
         (< (- (avg (map entry-score (take 3 history)))
               (avg (map entry-score (take 3 (drop 3 history)))))
            delta))))

(define (clickers-of personas reactions)
  (reduce (lambda (pr acc)
            (if (clicking? (field (cadr pr) "verdict"))
                (cons (car pr) acc) acc))
          '() (map list personas reactions)))

(define (frontier-of history personas inherited)
  (append inherited
    (map (lambda (e) (list (car e) (clickers-of personas (entry-reactions e))))
         history)))

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

(define (best-of history) (max-by entry-score history))

(define (gepa-until-plateau initial personas max-iter plateau-delta hints)
  (define (loop tagline iter history)
    (let* ((reactions (reactions-of tagline personas))
           (score     (click-rate reactions))
           (entry     (list tagline score reactions))
           (history+  (cons entry history))
           (fr        (frontier-of history+ personas hints)))
      (cond
        ((>= iter max-iter)                  (best-of history+))
        ((degrading? history+ plateau-delta) (best-of history+))
        (else (loop (next-tagline tagline fr) (+ iter 1) history+)))))
  (loop initial 0 '()))

;; ── triage ────────────────────────────────────────────────────────
(define (triage-one persona reaction tagline)
  (let ((v (car (infer/chat "high"
                  (list (infer/chat/system "stub")
                        (infer/chat/user
                          (string-append "TRIAGE|" persona "|"
                                         (field reaction "verdict") "|" tagline)))
                  TriageSchema
                  (string-append "triage/" tagline "/" persona)))))
    (dict "persona"  persona
          "reaction" reaction
          "mismatch" (field v "mismatch")
          "reason"   (field v "reason"))))

(define (triage-bouncers personas reactions tagline)
  (reduce (lambda (pr acc)
            (let ((p (car pr)) (r (cadr pr)))
              (if (bouncing? (field r "verdict"))
                  (cons (triage-one p r tagline) acc) acc)))
          '() (map list personas reactions)))

;; ── worklist driver ──────────────────────────────────────────────
;; Tail-recursive fold over a worklist of {personas, initial, parent-id, hints}.
;; Pushes a child task for the latent-fit (unsatisfied) subset; appends
;; the current branch's node to results unconditionally.
;;
;; Split into three phases so drive reads as score → build → route:
;;   score-task     — run inner loop, compute bounce-rate, triage if needed
;;   make-node      — pack a result record for the tree
;;   child-task-of  — build the next worklist task from this branch's findings

;; Phase 1: score a task. Returns (best-entry br triaged unsatisfied) as a
;; 4-list; drive destructures via (apply (lambda (…) …) (score-task task)),
;; the substrate-friendly substitute for R7RS let-values.
(define (score-task task)
  (let* ((personas   (field task "personas"))
         (initial    (field task "initial"))
         (hints      (field task "hints"))
         (best-entry (gepa-until-plateau initial personas
                       config/max-iter config/plateau-delta hints))
         (best-tag   (car best-entry))
         (reactions  (caddr best-entry))
         (br         (- 1 (cadr best-entry)))
         (triaged    (if (>= br config/bounce-threshold)
                         (triage-bouncers personas reactions best-tag)
                         '()))
         (unsatisfied (filter (lambda (t) (equal? (field t "mismatch") #f)) triaged)))
    (list best-entry br triaged unsatisfied)))

;; Phase 2: build the result node record.
(define (make-node node-id task best-entry br triaged)
  (dict "id"          node-id
        "parent-id"   (field task "parent-id")
        "tagline"     (car best-entry)
        "personas"    (field task "personas")
        "reactions"   (caddr best-entry)
        "bounce-rate" br
        "triaged"     triaged))

;; Phase 3: build the child worklist task (only called when we recurse).
(define (child-task-of parent-task parent-best-entry parent-node-id unsatisfied)
  (let ((personas (field parent-task "personas"))
        (hints    (field parent-task "hints")))
    (dict "personas"  (map (lambda (t) (field t "persona")) unsatisfied)
          "initial"   (car parent-best-entry)
          "parent-id" parent-node-id
          "hints"     (frontier-of (list parent-best-entry) personas hints))))

(define (optimize-tagline initial-tagline initial-personas)
  (define (drive worklist results total-iter)
    (cond
      ((null? worklist) (reverse results))
      ((>= total-iter config/total-iter-cap) (reverse results))
      (else
       (let ((task (car worklist)) (rest (cdr worklist)))
         (apply
           (lambda (best-entry br triaged unsatisfied)
             (let* ((node-id (length results))
                    (node    (make-node node-id task best-entry br triaged)))
               (cond
                 ((or (< br config/bounce-threshold) (null? unsatisfied))
                  (drive rest (cons node results) (+ total-iter 1)))
                 (else
                  (drive (cons (child-task-of task best-entry node-id unsatisfied) rest)
                         (cons node results)
                         (+ total-iter 1))))))
           (score-task task))))))
  (drive (list (dict "personas" initial-personas
                     "initial" initial-tagline
                     "parent-id" -1
                     "hints" '()))
         '() 0))
`;

const stub = (
  taglineVerdicts: Record<string, Record<string, string>>,
  reflectionChain: Record<string, string>,
  triageVerdicts: Record<string, { mismatch: boolean; reason: string }>,
) => {
  const complete = vi.fn(async (spec: ModelSpec) => {
    const parsed = JSON.parse(spec.prompt) as { role: string; content: string }[];
    const user = parsed.find((m) => m.role === "user")?.content ?? "";
    if (user.startsWith("REACT|")) {
      const [, tagline, persona] = user.split("|");
      const verdict = taglineVerdicts[tagline!]?.[persona!];
      if (!verdict) throw new Error(`stub: no react for ${user}`);
      return { verdict };
    }
    if (user.startsWith("REFLECT|")) {
      const [, tagline] = user.split("|");
      const next = reflectionChain[tagline!];
      if (next === undefined) throw new Error(`stub: no reflect for ${user}`);
      return { next };
    }
    if (user.startsWith("TRIAGE|")) {
      const [, persona] = user.split("|");
      const v = triageVerdicts[persona!];
      if (!v) throw new Error(`stub: no triage for ${user}`);
      return v;
    }
    throw new Error(`stub: unexpected: ${user}`);
  });
  return { complete };
};

describe("optimize-tagline — worklist driver", () => {
  it("single branch — low bounce, no triage, no recurse", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("config.scm", configScm({
      "max-iter": 1,
      "plateau-delta": -1,     // never plateau
      "total-iter-cap": 10,
      "bounce-threshold": 0.5,
    }));

    // iter 0 react t0: p1/p2/p3 all bounce → score 0
    // reflect → t1
    // iter 1 react t1: all click → score 1 (bounce-rate 0 < 0.5)
    // best = t1, no triage, no recurse
    const v = (a: string, b: string, c: string) => ({ p1: a, p2: b, p3: c });
    const backend = stub(
      { t0: v("bounce","bounce","bounce"), t1: v("click","click","click") },
      { t0: "t1" },
      {},
    );
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = (await project.run(`
(require "config.scm")
${PREAMBLE}
(optimize-tagline "t0" (list "p1" "p2" "p3"))
`)) as Array<Record<string, unknown>>;

    expect(out.length).toBe(1);
    expect(out[0]!.tagline).toBe("t1");
    expect(out[0]!["parent-id"]).toBe(-1);
    expect((out[0]!["bounce-rate"] as number)).toBe(0);
    // LIPS `'()` arrives JS-side as a Nil sentinel, not an Array — empty
    // triaged means low-bounce, so just check it isn't a populated array.
    expect(Array.isArray(out[0]!.triaged)).toBe(false);

    ac.abort(); await draining;
  });

  it("two branches — high bounce triggers triage and recursion on latent-fit subset", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("config.scm", configScm({
      "max-iter": 1,
      "plateau-delta": -1,
      "total-iter-cap": 10,
      "bounce-threshold": 0.25,
    }));

    // Root branch on [p1,p2,p3]:
    //   t0: p1=click p2=bounce p3=bounce → score 1/3, bounce 2/3 > 0.25
    //   reflect→t1 (with frontier (t0 (p1)))
    //   t1: p1=click p2=bounce p3=bounce → score 1/3, bounce 2/3 > 0.25
    //   best=t1 score 1/3. triage bouncers (p2,p3):
    //     p2 mismatch=true  (devops, hates JS)
    //     p3 mismatch=false (latent fit)
    //   unsatisfied=[p3], child task pushed.
    //
    // Child branch on [p3] with initial=t1, hints=(t1 (p1)):
    //   t1: p3=bounce → score 0
    //   reflect (sees hint t1:p1)→t2
    //   t2: p3=click → score 1, bounce 0 < 0.25
    //   best=t2, no triage.
    //
    // Expected: 2 nodes; root.id=0, child.id=1, child.parent-id=0.
    const v = (a: string, b: string, c: string) => ({ p1: a, p2: b, p3: c });
    const backend = stub(
      {
        t0: v("click","bounce","bounce"),
        t1: v("click","bounce","bounce"),
        t2: { p3: "click" },
      },
      { t0: "t1", t1: "t2" },
      {
        p2: { mismatch: true,  reason: "devops; rejects JS-based tooling" },
        p3: { mismatch: false, reason: "clarity issue, could be reached" },
      },
    );
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = (await project.run(`
(require "config.scm")
${PREAMBLE}
(optimize-tagline "t0" (list "p1" "p2" "p3"))
`)) as Array<Record<string, unknown>>;

    expect(out.length).toBe(2);
    const root = out[0]!;
    const child = out[1]!;
    expect(root.tagline).toBe("t1");
    expect(root["parent-id"]).toBe(-1);
    expect((root.triaged as unknown[]).length).toBe(2);
    expect(child.tagline).toBe("t2");
    expect(child["parent-id"]).toBe(0);
    expect((child.personas as string[])).toEqual(["p3"]);
    expect((child["bounce-rate"] as number)).toBe(0);

    ac.abort(); await draining;
  });

  it("total-iter-cap bounds the recursion (oscillation safety)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("config.scm", configScm({
      "max-iter": 0,
      "plateau-delta": -1,
      "total-iter-cap": 3,     // hard stop
      "bounce-threshold": 0.0, // any bounce triggers triage
    }));

    // Every persona bounces forever; every triage says "latent fit" → would
    // recurse infinitely. Cap forces stop after 3 branches.
    const backend = stub(
      { t0: { p1: "bounce" } },
      {},
      { p1: { mismatch: false, reason: "always reachable in theory" } },
    );
    const ac = new AbortController();
    const draining = startOrchestrator({ cache, router: singletonRouter(backend), signal: ac.signal }).done;

    const out = (await project.run(`
(require "config.scm")
${PREAMBLE}
(optimize-tagline "t0" (list "p1"))
`)) as Array<Record<string, unknown>>;

    expect(out.length).toBe(3);
    expect(out.every(n => n.tagline === "t0")).toBe(true);

    ac.abort(); await draining;
  });
});
