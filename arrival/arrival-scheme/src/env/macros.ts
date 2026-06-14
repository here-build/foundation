// @here.build/arrival-scheme/macros — threading & composition idiom macros,
// as a palette pack. Pure SchemePackSpec: name + bootstrap scheme source.
//
// LLMs and humans reach for whichever Lisp/FP idiom they know, so the family is
// accepted whole rather than forcing one dialect:
//   ->  / ~>   thread the value as the FIRST argument  (Clojure -> , Racket ~>)
//   ->> / ~>>  thread the value as the LAST argument    (Clojure ->>, Racket ~>>)
//   compose / comp   right-to-left composition  ((compose f g) x) => (f (g x))
//   pipe / flow      left-to-right composition   ((pipe f g) x)    => (g (f x))
//
// Wiring-only (no resources) → pause-trivial. Source mirrors arrival-scheme/src/
// bootstrap.ts (originals untouched). NOTE: scoped to the self-contained idiom
// family — cut/cute (which need gensym + JS interop) stay out of this atomic pack.

import { EnvCapability } from "./capability.js";

const MACROS_SCHEME = `
;; ---- Threading & composition (polyglot) ----
(define (compose . fns)
  (lambda args
    (let ((rfns (reverse fns)))
      (if (null? rfns)
          (if (null? args) #void (car args))
          (let loop ((fs (cdr rfns)) (acc (apply (car rfns) args)))
            (if (null? fs) acc (loop (cdr fs) ((car fs) acc))))))))
(define comp compose)

(define (pipe . fns)
  (lambda args
    (if (null? fns)
        (if (null? args) #void (car args))
        (let loop ((fs (cdr fns)) (acc (apply (car fns) args)))
          (if (null? fs) acc (loop (cdr fs) ((car fs) acc)))))))
(define flow pipe)

(define-macro (-> x . forms)
  (if (null? forms)
      x
      (let ((form (car forms)))
        \`(-> ,(if (pair? form)
                   (cons (car form) (cons x (cdr form)))
                   (list form x))
             ,@(cdr forms)))))

(define-macro (->> x . forms)
  (if (null? forms)
      x
      (let ((form (car forms)))
        \`(->> ,(if (pair? form)
                    (append form (list x))
                    (list form x))
              ,@(cdr forms)))))

(define-macro (~> x . forms) \`(-> ,x ,@forms))
(define-macro (~>> x . forms) \`(->> ,x ,@forms))
`;

/** Threading & composition idiom macros. Prelude-only module-singleton capability. */
export default new EnvCapability("scheme/macros-threading", { prelude: MACROS_SCHEME });
