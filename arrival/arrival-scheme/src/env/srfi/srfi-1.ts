// SRFI-1 — list library completion. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `SRFI1_SCM` and
// concatenates it, so this module is the sole definition site. It used to be
// byte-duplicated inline in bootstrap.ts; the docstrings travelled here with the code.
//
// SCOPE: this is the SRFI-1 *completion* set (take-while … length+). The SRFI-1
// "missing third" (iota, delete-duplicates, filter-map, count, list-index,
// append-map) plus zip/some/every/unfold still live inline in bootstrap.ts and
// are slated to join this module in a later phase. The arrival safe-accessors
// (first?/first-or) and the Ramda-override `remove` deliberately stay in core.
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
`;

export default new EnvCapability("scheme/srfi-1", { prelude: SRFI1_SCM });
