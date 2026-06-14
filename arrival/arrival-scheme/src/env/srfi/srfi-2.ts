// SRFI-2 — and-let*. The bootstrap defines this with `define-syntax`, which is
// FULL-env-only (the sandbox's LIPS matcher has no `define-syntax`). Re-expressed
// here as a recursive `define-macro` (the sandbox-supported path) — same semantics:
// each claw `(var expr)` binds+tests, `(expr)` tests, a bare symbol tests; first #f short-circuits.
import { EnvCapability } from "../capability.js";

export default new EnvCapability("scheme/srfi-2", {
  prelude: `
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
`,
});
