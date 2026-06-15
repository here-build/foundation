// SRFI-1 — list library completion. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `SRFI1_SCM` and
// concatenates it, so this module is the sole definition site. It used to be
// byte-duplicated inline in bootstrap.ts; the docstrings travelled here with the code.
//
// SCOPE: the whole SRFI-1 surface lives here in two blocks — the *completion*
// set (take-while … length+) and the "missing third" + parallel-list utilities
// (iota, delete-duplicates, filter-map, count, append-map, some/every, zip,
// list-index, unfold). The arrival safe-accessors (first?/first-or) and the
// Ramda-override `remove` deliberately stay in core (bootstrap.ts): the
// accessors are arrival-specific crash-avoidance, and `remove` exists to
// override the Ramda spread into the sandbox.
import { EnvCapability } from "../capability.js";

export const SRFI1_SCM = `
;; ============ SRFI-1 (list library completion) ============
;; take-while — longest prefix of xs satisfying pred.
(define (take-while pred xs)
  (let loop ((xs xs) (acc '()))
    (if (and (pair? xs) (pred (car xs)))
        (loop (cdr xs) (cons (car xs) acc))
        (reverse acc))))

;; drop-while — xs with the take-while prefix removed.
(define (drop-while pred xs)
  (let loop ((xs xs))
    (if (and (pair? xs) (pred (car xs)))
        (loop (cdr xs))
        xs)))

;; span — (values (take-while pred xs) (drop-while pred xs)).
(define (span pred xs)
  (let loop ((xs xs) (acc '()))
    (if (and (pair? xs) (pred (car xs)))
        (loop (cdr xs) (cons (car xs) acc))
        (values (reverse acc) xs))))

;; break — span on the negation of pred.
(define (break pred xs)
  (let loop ((xs xs) (acc '()))
    (if (and (pair? xs) (not (pred (car xs))))
        (loop (cdr xs) (cons (car xs) acc))
        (values (reverse acc) xs))))

;; partition — (values yes no) splitting xs by pred.
(define (partition pred xs)
  (let loop ((xs xs) (yes '()) (no '()))
    (cond ((null? xs) (values (reverse yes) (reverse no)))
          ((pred (car xs)) (loop (cdr xs) (cons (car xs) yes) no))
          (else (loop (cdr xs) yes (cons (car xs) no))))))

;; find-tail — first tail of xs whose car satisfies pred, else #f.
(define (find-tail pred xs)
  (let loop ((xs xs))
    (cond ((null? xs) #f)
          ((pred (car xs)) xs)
          (else (loop (cdr xs))))))

;; last-pair — the last pair of a non-empty list.
(define (last-pair xs)
  (let loop ((xs xs))
    (if (pair? (cdr xs)) (loop (cdr xs)) xs)))

;; last — the last element of a non-empty list.
(define (last xs) (car (last-pair xs)))

;; list-tabulate — (list (f 0) (f 1) ... (f (- n 1))).
(define (list-tabulate n f)
  (let loop ((i (- n 1)) (acc '()))
    (if (< i 0) acc (loop (- i 1) (cons (f i) acc)))))

;; fold-right — right-associative fold: (f x0 (f x1 ... (f xn knil))).
(define (fold-right f knil xs)
  (let loop ((xs xs))
    (if (null? xs) knil (f (car xs) (loop (cdr xs))))))

;; reduce-right — fold-right with the last element as the seed; ridentity if empty.
(define (reduce-right f ridentity xs)
  (if (null? xs)
      ridentity
      (let loop ((xs xs))
        (if (null? (cdr xs))
            (car xs)
            (f (car xs) (loop (cdr xs)))))))

;; concatenate — append a list of lists.
(define (concatenate lists) (apply append lists))

;; append-reverse — (append (reverse rev) tail), accumulator-friendly.
(define (append-reverse rev tail)
  (let loop ((rev rev) (tail tail))
    (if (null? rev) tail (loop (cdr rev) (cons (car rev) tail)))))

;; delete — remove all elements equal? to x from xs.
(define (delete x xs)
  (let loop ((xs xs) (acc '()))
    (cond ((null? xs) (reverse acc))
          ((equal? x (car xs)) (loop (cdr xs) acc))
          (else (loop (cdr xs) (cons (car xs) acc))))))

;; length+ — list length, or #f for a circular list (Floyd cycle detection).
(define (length+ xs)
  (let loop ((slow xs) (fast xs) (n 0))
    (cond ((null? fast) n)
          ((not (pair? fast)) n)
          ((null? (cdr fast)) (+ n 1))
          ((not (pair? (cdr fast))) (+ n 1))
          (else
            (let ((slow2 (cdr slow)) (fast2 (cdr (cdr fast))))
              (if (eq? slow2 fast2) #f (loop slow2 fast2 (+ n 2))))))))

;; ============ SRFI-1 (the missing third + parallel-list utilities) ============
;; Relocated here from bootstrap.ts so the whole SRFI-1 surface is observable in
;; one module. These retire the hand-rolled dedupe/member?/index-map helpers that
;; were reinvented across the pipeline.

;; iota — (iota count [start step]); a list of count integers from start by step.
(define (iota count . rest)
  (let ((start (if (null? rest) 0 (car rest)))
        (step (if (or (null? rest) (null? (cdr rest))) 1 (cadr rest))))
    (let loop ((i 0) (acc '()))
      (if (>= i count) (reverse acc)
          (loop (+ i 1) (cons (+ start (* i step)) acc))))))

;; delete-duplicates — order-preserving dedup by equal?. Retires the O(n²) hand-rolled
;; dedupe reinvented across the pipeline.
(define (delete-duplicates xs)
  (let loop ((xs xs) (seen '()) (acc '()))
    (if (null? xs) (reverse acc)
        (if (member (car xs) seen)
            (loop (cdr xs) seen acc)
            (loop (cdr xs) (cons (car xs) seen) (cons (car xs) acc))))))

;; filter-map — map then drop the falsy results, in one pass the model can't mismatch.
(define (filter-map fn . lists)
  (filter (lambda (x) x) (apply map fn lists)))

;; count — how many element-tuples satisfy pred.
(define (count pred . lists)
  (length (filter (lambda (b) b) (apply map pred lists))))

;; append-map — map then append the result lists.
(define (append-map fn . lists)
  (apply append (apply map fn lists)))

;; some / every — existence and universal quantifiers over parallel lists. (some is
;; SRFI-1's \`any\`, kept under the Ramda-familiar name.) %any-null?/%some/%every are
;; private helpers; some must precede zip and list-index, which call it.
(define (%any-null? lst)
  (if (null? lst)
      false
      (if (null? (car lst))
          true
          (%any-null? (cdr lst)))))

(define (%some fn lists)
  (if (or (null? lists) (%any-null? lists))
      false
      (if (apply fn (map car lists))
          true
          (%some fn (map cdr lists)))))

(define (some fn . lists)
  (typecheck "some" fn "function")
  (%some fn lists))

(define (%every fn lists)
  (if (or (null? lists) (%any-null? lists))
      true
      (and (apply fn (map car lists)) (%every fn (map cdr lists)))))

(define (every fn . lists)
  (typecheck "every" fn "function")
  (%every fn lists))

;; zip — transpose parallel lists into a list of tuples; stops at the shortest.
(define (zip . lists)
  (if (or (null? lists) (some null? lists))
      '()
      (cons (map car lists) (apply zip (map cdr lists)))))

;; list-index — index of the first element-tuple satisfying pred, or #f.
(define (list-index pred . lists)
  (let loop ((i 0) (ls lists))
    (if (some null? ls) #f
        (if (apply pred (map car ls)) i
            (loop (+ i 1) (map cdr ls))))))

;; unfold — build a list by iterating fn from init; fn returns (head . next) or #f to stop.
(define (unfold fn init)
  (typecheck "unfold" fn "function")
  (let iter ((pair (fn init)) (result '()))
    (if (not pair)
        (reverse result)
        (iter (fn (cdr pair)) (cons (car pair) result)))))
`;

export default new EnvCapability("scheme/srfi-1", { prelude: SRFI1_SCM });
