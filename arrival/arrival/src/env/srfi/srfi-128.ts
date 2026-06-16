// SRFI-128 — comparators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles `SRFI128_SCM` and
// evals it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../capability.js";

export const SRFI128_SCM = `
;; ============ SRFI-128 (comparators) ============
;; ---- SRFI-128 comparators (tagged-list; NO hash — arrival has no value-hash,
;; so comparator-hashable? is always #f and the hash arg is ignored) ----

;; make-comparator — bundle (type-test equality ordering). A 4th hash arg is
;; accepted for SRFI-128 source-compat but IGNORED.
(define (make-comparator type-test equality ordering . hash)
  (list 'comparator type-test equality ordering))
(define (comparator? x) (and (pair? x) (eq? (car x) 'comparator)))
(define (comparator-type-test-predicate c) (cadr c))
(define (comparator-equality-predicate c) (caddr c))
(define (comparator-ordering-predicate c) (cadddr c))
(define (comparator-hashable? c) #f)

;; %chain-rel — rel holds for every adjacent pair in (a b . rest).
(define (%chain-rel rel a b rest)
  (if (rel a b)
      (if (null? rest) #t (%chain-rel rel b (car rest) (cdr rest)))
      #f))

(define (=? c a b . rest) (%chain-rel (comparator-equality-predicate c) a b rest))
(define (<? c a b . rest) (%chain-rel (comparator-ordering-predicate c) a b rest))
(define (>? c a b . rest)
  (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (lt y x)) a b rest)))
(define (<=? c a b . rest)
  (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (not (lt y x))) a b rest)))
(define (>=? c a b . rest)
  (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (not (lt x y))) a b rest)))

;; %type-rank / %default-less — a TOTAL order across types: by type rank, then
;; the native within-type order.
(define (%type-rank x)
  (cond ((boolean? x) 0) ((number? x) 1) ((char? x) 2) ((string? x) 3)
        ((symbol? x) 4) ((null? x) 5) ((pair? x) 6) (else 7)))
(define (%default-less a b)
  (let ((ra (%type-rank a)) (rb (%type-rank b)))
    (if (not (= ra rb)) (< ra rb)
        (cond ((number? a) (< a b))
              ((char? a) (char<? a b))
              ((string? a) (string<? a b))
              ((symbol? a) (string<? (symbol->string a) (symbol->string b)))
              ((boolean? a) (and (not a) b))
              (else #f)))))
(define (make-default-comparator) (make-comparator (lambda (x) #t) equal? %default-less))
(define (default-comparator) (make-default-comparator))
`;

export default new EnvCapability("scheme/srfi-128", { prelude: SRFI128_SCM });
