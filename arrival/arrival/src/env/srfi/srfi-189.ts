// SRFI-189 — Maybe & Either. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles `SRFI189_SCM` and
// evals it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../capability.js";

export const SRFI189_SCM = `
;; ============ SRFI-189 (Maybe & Either) ============
;; ---- SRFI-189 Maybe & Either (tagged-list values) ----

;; just: wrap a value as a Just
(define (just x) (list 'just x))
;; nothing: the empty Maybe
(define (nothing) (list 'nothing))
;; left: wrap a value as a Left (failure side of Either)
(define (left x) (list 'left x))
;; right: wrap a value as a Right (success side of Either)
(define (right x) (list 'right x))

;; just?: is this a Just?
(define (just? m) (and (pair? m) (eq? (car m) 'just)))
;; nothing?: is this a Nothing?
(define (nothing? m) (and (pair? m) (eq? (car m) 'nothing)))
;; maybe?: is this any Maybe?
(define (maybe? m) (or (just? m) (nothing? m)))
;; left?: is this a Left?
(define (left? e) (and (pair? e) (eq? (car e) 'left)))
;; right?: is this a Right?
(define (right? e) (and (pair? e) (eq? (car e) 'right)))
;; either?: is this any Either?
(define (either? e) (or (left? e) (right? e)))

;; maybe-ref: unwrap a Just; on Nothing call failure thunk (default: error)
(define (maybe-ref m . failure)
  (cond ((just? m) (car (cdr m)))
        ((pair? failure) ((car failure)))
        (else (error "maybe-ref: Nothing"))))
;; maybe-ref/default: unwrap a Just, else return default
(define (maybe-ref/default m default)
  (if (just? m) (car (cdr m)) default))
;; maybe-bind: monadic bind; Nothing short-circuits
(define (maybe-bind m f)
  (if (just? m) (f (car (cdr m))) m))
;; maybe-map: map over the wrapped value, preserving Nothing
(define (maybe-map f m)
  (if (just? m) (just (f (car (cdr m)))) m))
;; maybe->list: '() for Nothing, (value) for Just
(define (maybe->list m)
  (if (just? m) (list (car (cdr m))) '()))
;; list->maybe: '() -> Nothing, else Just of the first element
(define (list->maybe lst)
  (if (null? lst) (nothing) (just (car lst))))
;; maybe->either: Nothing -> (left no-just), Just x -> (right x)
(define (maybe->either m no-just)
  (if (just? m) (right (car (cdr m))) (left no-just)))

;; either-ref: unwrap a Right; on Left call failure with left value (default: error)
(define (either-ref e . failure)
  (cond ((right? e) (car (cdr e)))
        ((pair? failure) ((car failure) (car (cdr e))))
        (else (error "either-ref: Left"))))
;; either-ref/default: unwrap a Right, else return default
(define (either-ref/default e default)
  (if (right? e) (car (cdr e)) default))
;; either-bind: monadic bind; Left short-circuits
(define (either-bind e f)
  (if (right? e) (f (car (cdr e))) e))
;; either-map: map over a Right, preserving Left
(define (either-map f e)
  (if (right? e) (right (f (car (cdr e)))) e))
;; either->list: '() for Left, (value) for Right
(define (either->list e)
  (if (right? e) (list (car (cdr e))) '()))
;; either-swap: (left x) <-> (right x)
(define (either-swap e)
  (cond ((left? e) (right (car (cdr e))))
        ((right? e) (left (car (cdr e))))
        (else (error "either-swap: not an Either"))))
`;

export default new EnvCapability("scheme/srfi-189", { prelude: SRFI189_SCM });
