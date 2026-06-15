// SRFI-2 — and-let*. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `SRFI2_SCM` and
// concatenates it, so this module is the sole definition site.
//
// DIALECT UNIFICATION: the bootstrap historically defined `and-let*` with
// `define-syntax`/`syntax-rules`, which is FULL-env-only (the sandbox's matcher
// has no `define-syntax`). This module re-expresses it once as a recursive
// `define-macro` (the sandbox-supported path), and the bootstrap now
// single-sources from here — one definition for both envs.
import { EnvCapability } from "../capability.js";

export const SRFI2_SCM = `
;; ============ SRFI-2 and-let* ============
;; and-let* (SRFI-2) — sequential AND with binding. Claw (var expr) binds+tests var;
;; claw (expr) is a bare guard; a bare symbol tests itself. Any #f short-circuits the
;; whole form to #f; otherwise the value is the body (or #t when there is no body).
(define-macro (and-let* claws . body)
  (if (null? claws)
      (if (null? body) #t \`(begin ,@body))
      (let ((claw (car claws)) (rest (cdr claws)))
        (cond
          ((and (pair? claw) (pair? (cdr claw)))
           \`(let ((,(car claw) ,(cadr claw)))
              (if ,(car claw) (and-let* ,rest ,@body) #f)))
          ((pair? claw)
           \`(if ,(car claw) (and-let* ,rest ,@body) #f))
          (else
           \`(if ,claw (and-let* ,rest ,@body) #f))))))
`;

export default new EnvCapability("scheme/srfi-2", { prelude: SRFI2_SCM });
