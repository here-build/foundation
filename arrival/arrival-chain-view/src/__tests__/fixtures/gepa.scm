;; GEPA — reflective, Pareto-based prompt evolution. Logic only;
;; the two prompts live in predict.prompt and improve.prompt.
;;
;; Open this folder in the studio and watch it run: every (infer …) lights up the
;; trace as candidates are scored, reflected on, and selected. Re-run replays
;; from cache for $0; edit a prompt → only the affected calls re-mint.

(require "metric.scm")                            ; spills `metric` : (prediction expected) -> 0 | 1
(define examples (require "examples.json"))       ; each: {id, input, expected}
(define run-predict (require "predict.prompt"))
(define run-improve (require "improve.prompt"))

;; Call the prompts with a content-derived cache key, so identical calls replay.
(define (ask instruction input)
  (run-predict (list instruction input) :instruction instruction :input input))

(define (reflect instruction failures)
  (run-improve (list instruction failures) :instruction instruction :failures failures))

;; Score an instruction across every example, in parallel.
(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))

;; A candidate is an instruction together with its per-example scores.
(define (assess instruction)
  (dict :instruction instruction :scores (evaluate instruction)))

;; A readable summary of the examples this candidate got wrong.
(define (failing candidate) (map car (filter (lambda (pair) (zero? (cadr pair))) (map list examples (:scores candidate)))))

;; Reflective mutation: hand this candidate's failures to the reflect prompt.
(define (mutate candidate)
  (assess (reflect (:instruction candidate) (failing candidate))))

;; Pareto frontier: keep every candidate no other candidate beats outright.
(define (dominates? a b)
  (and (every >= (:scores a) (:scores b))
       (some  >  (:scores a) (:scores b))))

(define (frontier pool)
  (filter (lambda (c) (not (some (lambda (other) (dominates? other c)) pool))) pool))

;; Apply `step` to the pool `n` times.
(define (iterate step pool n)
  (if (zero? n) pool (iterate step (step pool) (- n 1))))

;; One generation: mutate each survivor, then re-select the frontier over all.
(define (generation pool)
  (frontier (append pool (map mutate pool))))

;; Evolve from the seed for `rounds` generations; keep the best on the full set.
(define (gepa seed rounds)
  (max-by (lambda (c) (apply + (:scores c)))
          (iterate generation (list (assess seed)) rounds)))

;; The winning candidate — its :instruction is the optimized prompt.
(gepa (require "seed.txt") 4)
