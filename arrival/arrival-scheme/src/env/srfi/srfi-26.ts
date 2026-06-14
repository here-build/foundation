// SRFI-26 — cut / cute (parameter specialization). Scheme-bootstrap capability. Source mirrors arrival-scheme/src/bootstrap.ts.
import { EnvCapability } from "../capability.js";

export default new EnvCapability("scheme/srfi-26", {
  prelude: `
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
`,
});
