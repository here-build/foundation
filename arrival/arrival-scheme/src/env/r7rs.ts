// @here.build/arrival-scheme/r7rs — standard R7RS derived-syntax pack.
//
// The portable Scheme control forms arrival supports as macros, expanded from
// the small special-form core: cond / case / when / unless, let-values /
// let*-values, and the R7RS §6.11 exception system (raise, raise-continuable,
// with-exception-handler, error, guard). %else-literal? is the private helper
// that lets cond/case recognise a literal `else` clause.
//
// These are the OPPOSITE face of the purity doors in bootstrap.ts: the doors
// name what R7RS arrival omits (dynamics + mutators) for provenance soundness;
// this pack supplies what R7RS arrival keeps. It depends on the host try /
// catch / finally + %raise primitives, on which the exception forms are built.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `R7RS_SCM` and
// concatenates it, so this module is the sole definition site.
import { EnvCapability } from "./capability.js";

export const R7RS_SCM = `
(define (%else-literal? obj)
  (and (symbol? obj)
       (or (eq? obj 'else)
           (eq? (--> (new scheme.SchemeString (obj.literal))
                     (cmp "else")) 0))))

;; -----------------------------------------------------------------------------
;; R7RS cond macro
;; -----------------------------------------------------------------------------
(define-macro (cond . list)
  (if (pair? list)
      (let* ((item (car list))
             (value (gensym))
             (first (car item))
             (fn (and (not (null? (cdr item))) (eq? (cadr item) '=>)))
             (expression (if fn
                             (caddr item)
                             (cdr item)))
             (rest (cdr list)))
        (if (%else-literal? first)
            \`(begin
               ,@expression)
            \`(let ((,value ,first))
               (if ,value
                   ,(if fn
                        \`(,expression ,value)
                        \`(begin
                           ,@expression))
                   ,(if (not (null? rest))
                        \`(cond ,@rest))))))
      '()))

;; -----------------------------------------------------------------------------
;; R7RS when and unless macros
;; -----------------------------------------------------------------------------
(define-macro (when test . body)
  \`(if ,test
       (begin ,@body)))

(define-macro (unless test . body)
  \`(if (not ,test)
       (begin ,@body)))

;; -----------------------------------------------------------------------------
;; R7RS case macro
;; -----------------------------------------------------------------------------
(define-macro (case key . clauses)
  (let ((key-val (gensym "key")))
    \`(let ((,key-val ,key))
       (cond
         ,@(map (lambda (clause)
                  (let* ((datums (car clause))
                         (rest (cdr clause))
                         (has-arrow (and (pair? rest)
                                        (pair? (cdr rest))
                                        (eq? (car rest) '=>)))
                         (proc (if has-arrow (cadr rest) #f))
                         (exprs (if has-arrow #f rest)))
                    (if (%else-literal? datums)
                        (if has-arrow
                            \`(else (,proc ,key-val))
                            \`(else ,@exprs))
                        (if has-arrow
                            \`((memv ,key-val ',datums) (,proc ,key-val))
                            \`((memv ,key-val ',datums) ,@exprs)))))
                clauses)))))

;; -----------------------------------------------------------------------------
;; R7RS let-values and let*-values
;; -----------------------------------------------------------------------------
(define-macro (let-values bindings . body)
  (if (null? bindings)
      \`(begin ,@body)
      (let* ((first-binding (car bindings))
             (vars (car first-binding))
             (expr (cadr first-binding))
             (rest-bindings (cdr bindings)))
        \`(call-with-values
           (lambda () ,expr)
           (lambda ,vars
             (let-values ,rest-bindings ,@body))))))

(define-macro (let*-values bindings . body)
  (if (null? bindings)
      \`(begin ,@body)
      (let* ((first-binding (car bindings))
             (vars (car first-binding))
             (expr (cadr first-binding))
             (rest-bindings (cdr bindings)))
        \`(call-with-values
           (lambda () ,expr)
           (lambda ,vars
             (let*-values ,rest-bindings ,@body))))))

;; -----------------------------------------------------------------------------
;; R7RS Exception Handling
;; -----------------------------------------------------------------------------
(define *current-exception-handlers* '())

;; R7RS §6.11: raise invokes the current handler in the dynamic environment of
;; the call to raise, except that the current exception handler is the one that
;; was in place when THIS handler was installed (i.e. the rest of the stack).
;; So we POP the handler before invoking it — otherwise a raise inside the
;; handler re-reads the same car and recurs forever. If a non-continuable
;; handler returns, a secondary exception is raised in the handler's dynamic
;; environment (the popped stack still in place).
(define (raise obj)
  (if (null? *current-exception-handlers*)
      (%raise obj)
      (let ((handler (car *current-exception-handlers*))
            (rest (cdr *current-exception-handlers*)))
        (set! *current-exception-handlers* rest)
        (handler obj)
        ;; handler returned for a non-continuable exception → secondary raise,
        ;; still with the popped stack (rest) in place.
        (raise (make-error-object
                 "exception handler returned for non-continuable exception")))))

;; raise-continuable: same pop discipline, but the handler's return value is
;; returned to the call site of raise-continuable. Restore the stack on the way
;; out so the value flows back into the original dynamic environment.
(define (raise-continuable obj)
  (if (null? *current-exception-handlers*)
      (%raise obj)
      (let ((handler (car *current-exception-handlers*))
            (rest *current-exception-handlers*))
        (set! *current-exception-handlers* (cdr rest))
        (try
          (handler obj)
          (finally
            (set! *current-exception-handlers* rest))))))

;; with-exception-handler installs handler for the duration of thunk and removes
;; it on the way out — via finally, which restores the stack whether thunk
;; returns normally OR escapes via a thrown exception (e.g. a handler that exits
;; through guard's catch). No catch+re-raise here: re-raising would re-deliver an
;; exception the inner handler already saw to the outer handler (double delivery).
(define (with-exception-handler handler thunk)
  (let ((old-handlers *current-exception-handlers*))
    (set! *current-exception-handlers* (cons handler old-handlers))
    (try
      (thunk)
      (finally
        (set! *current-exception-handlers* old-handlers)))))

(define (error message . irritants)
  (raise (apply make-error-object message irritants)))

(define-macro (guard clause-and-body . rest)
  (let* ((var (car clause-and-body))
         (clauses (cdr clause-and-body))
         (body rest))
    \`(try
       (begin ,@body)
       (catch (,var)
         (cond
           ,@clauses
           (else (raise ,var)))))))
`;

export default new EnvCapability("scheme/r7rs", { prelude: R7RS_SCM });
