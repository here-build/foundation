import { createInferStore, type ModelSpec, singletonRouter } from "@here.build/arrival-inference";
import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";

// Characterization of the sift/closure.scm BROWSER HANG (V, 2026-06-14).
//
// closure.scm computes a transitive closure with `loop-until-dry`: derive facts until a round adds
// nothing new (dedup by a string `claim-id`). By hand it MUST converge — rules a→b→c→c, the c→c
// self-loop dedups out, `dry` hits patience=1, done (3 facts). Yet it hangs the canvas.
//
// ROOT CAUSE (proven below): arrival's `equal?` is PROVENANCE-SENSITIVE. Two content-identical strings
// compare UNEQUAL when their provenance differs (R7RS says `equal?` on strings is content equality;
// `string=?` does it right, `equal?` does not). In the loop, `seen` accumulates facts at different
// derivation depths (different provenance), so their identical claim-ids never match → the dedup never
// fires → `fresh` never empties → `seen` DOUBLES every round → unbounded growth → OOM/hang. The heap
// budget can't save it: each cell is a dict carrying an ever-growing provenance set, so the JS heap
// dies before the cell cap.
//
// These tests run BOUNDED round counts (never the unbounded loop) so the suite itself can't OOM.

function project() {
  const p = ArrivalChain.bootstrap(new Project()).root;
  p.bindInfer(createInferStore(singletonRouter({ complete: vi.fn(async (_s: ModelSpec) => ({ value: "" })) })));
  return p;
}
const run = (src: string): Promise<unknown> => project().run(src, { dirname: "", budgetMs: 5000 });

// closure.scm's deps (lib.scm + pipeline.scm), inlined and parameterized over the equality used for
// dedup, so we can swap `equal?` (the buggy one) for `string=?` (provenance-blind) and watch it fix.
const DEFS = (eqOp: string): string => `
(define (str-eq? a b) (${eqOp} a b))
(define (member-str? x xs) (> (length (filter (lambda (y) (str-eq? y x)) xs)) 0))
(define (join-by sep xs)
  (if (null? xs) "" (let loop ((acc (car xs)) (rest (cdr xs)))
    (if (null? rest) acc (loop (string-append acc sep (car rest)) (cdr rest))))))
(define (val->str v)
  (cond ((string? v) v) ((number? v) (number->string v)) ((null? v) "()")
        ((pair? v) (string-append "(" (join-by " " (map val->str v)) ")")) (else "?")))
(define (canonical-verdict v) (join-by " " (map val->str (if (pair? v) v (list v)))))
(define (claim-id f) (string-append (val->str (:family f)) "|" (canonical-verdict (:verdict f))))
(define seed (list (dict :family "f" :verdict (list "a"))))
(define rules (list (cons "a" "b") (cons "b" "c") (cons "c" "c")))
(define (derive seen)
  (apply append (map (lambda (f)
       (map (lambda (r) (dict :family "f" :verdict (list (cdr r))))
            (filter (lambda (r) (equal? (car r) (car (:verdict f)))) rules))) seen)))
;; run EXACTLY n rounds (BOUNDED — never the unbounded patience loop), return seen-size.
(define (closure-size n)
  (let loop ((seen (list)) (round 0))
    (if (>= round n) (length seen)
        (let ((fresh (filter (lambda (x) (not (member-str? (claim-id x) (map claim-id seen))))
                             (if (null? seen) seed (derive seen)))))
          (loop (append seen fresh) (+ round 1))))))
`;

describe("sift/closure.scm hang — fixed by representation-blind equal?", () => {
  // 1. THE FIX, end-to-end. closure.scm dedups with `equal?` (via member?). The bug was that a boxed
  //    SchemeString (a chain-plane derived claim-id) never equaled a content-identical plain string,
  //    so dedup never fired and seen-size DOUBLED every round (1,2,4,8,16,32 → unbounded → hang). With
  //    equal? made representation-blind, the SAME `equal?`-dedup now CONVERGES to 3 and stays.
  it("equal?-dedup converges to 3 (was unbounded doubling) — the real closure.scm path", async () => {
    const sizes: number[] = [];
    for (let n = 1; n <= 6; n++) sizes.push((await run(`${DEFS("equal?")}\n(closure-size ${n})`)) as number);
    console.log("[FIXED] equal?-dedup seen-size per round 1..6:", sizes.join(", "), "(converges + stays at 3)");
    expect(sizes).toEqual([1, 2, 3, 3, 3, 3]); // a→ab→abc→fixpoint (was [1,2,4,8,16,32] before the fix)
  });

  // 2. THE ROOT CAUSE, now resolved. A DERIVED claim-id (boxed SchemeString) and a content-identical
  //    LITERAL now compare EQUAL under equal? — matching string=?. (Pre-fix: equal? was #f.)
  it("equal? is now representation-blind: derived (boxed) vs literal string compare equal", async () => {
    const v = (await run(`${DEFS("equal?")}
      (define b (car (derive seed)))            ;; a DERIVED fact {b} (chain-boxed claim-id)
      (list (claim-id b)
            (equal?  (claim-id b) "f|b")          ;; representation-blind → #t (fixed; was #f)
            (string=? (claim-id b) "f|b"))`)) as unknown[];
    console.log("[ROOT CAUSE FIXED] [claim-id, (equal? derived literal), (string=? derived literal)]:", JSON.stringify(v));
    expect(v[0]).toBe("f|b");
    expect(v[1]).toBe(true); // equal? now agrees with string=? — boxed ≡ unboxed content
    expect(v[2]).toBe(true);
  });

  // 3. string=? still converges (it was always content-based) — the control that pinned the diagnosis.
  it("string=?-dedup also converges to 3 (the always-correct control)", async () => {
    const sizes: number[] = [];
    for (let n = 1; n <= 6; n++) sizes.push((await run(`${DEFS("string=?")}\n(closure-size ${n})`)) as number);
    console.log("[CONTROL] string=?-dedup seen-size per round 1..6:", sizes.join(", "));
    expect(sizes).toEqual([1, 2, 3, 3, 3, 3]);
  });
});
