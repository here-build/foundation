// SRFI-26 — cut / cute (parameter specialization). Scheme-bootstrap capability.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `SRFI26_SCM` and
// concatenates it, so this module is the sole definition site. It used to be
// byte-duplicated inline in bootstrap.ts; the docstrings travelled here with the code.
import { EnvCapability } from "../capability.js";

export const SRFI26_SCM = `
;; -----------------------------------------------------------------------------
;; SRFI-26 — cut / cute: specialize parameters without currying
;; -----------------------------------------------------------------------------
;; \`<>\` is a positional slot, \`<...>\` a (final) rest slot. \`(cut f a <>)\` builds
;;   (lambda (g) (f a g)); \`(cut f <...>)\` builds (lambda (. g) (apply f g)).
;; cut leaves non-slot subexpressions in the body, so they re-evaluate on every
;; call; cute lifts them into a let so they evaluate ONCE at specialization
;; (SRFI-26's whole point: \`(cute f (expensive) <>)\` calls (expensive) once).
;; Slot params are gensym'd so a non-slot expr referencing a same-named variable
;; can't be captured. Walks the items into a fixed-param list + a call form, with
;; <...> flipping to a rest param applied via \`apply\`.
(define-macro (cut . items)
  (let loop ((items items) (params '()) (call '()) (restp #f))
    (cond
      ((null? items)
       (if restp
           \`(lambda ,(append (reverse params) restp) (apply ,@(reverse call) ,restp))
           \`(lambda ,(reverse params) (,@(reverse call)))))
      ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<>"))
       (let ((g (gensym))) (loop (cdr items) (cons g params) (cons g call) restp)))
      ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<...>"))
       (loop (cdr items) params call (gensym)))
      (else (loop (cdr items) params (cons (car items) call) restp)))))

(define-macro (cute . items)
  (let loop ((items items) (params '()) (call '()) (binds '()) (restp #f))
    (cond
      ((null? items)
       (let ((lam (if restp
                      \`(lambda ,(append (reverse params) restp) (apply ,@(reverse call) ,restp))
                      \`(lambda ,(reverse params) (,@(reverse call))))))
         (if (null? binds) lam \`(let ,(reverse binds) ,lam))))
      ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<>"))
       (let ((g (gensym))) (loop (cdr items) (cons g params) (cons g call) binds restp)))
      ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<...>"))
       (loop (cdr items) params call binds (gensym)))
      (else (let ((t (gensym))) (loop (cdr items) params (cons t call) (cons (list t (car items)) binds) restp))))))
`;

export default new EnvCapability("scheme/srfi-26", { prelude: SRFI26_SCM });
