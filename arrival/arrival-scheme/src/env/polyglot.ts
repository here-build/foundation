// @here.build/arrival-scheme/polyglot — the polyglot idiom pack.
//
// One principle: LLMs and humans reach for whichever Lisp/FP idiom they already
// know, so accept the whole family rather than forcing one dialect. Today that
// family is threading & composition:
//   ->  / ~>   thread the value as the FIRST argument  (Clojure -> , Racket ~>)
//   ->> / ~>>  thread the value as the LAST argument    (Clojure ->>, Racket ~>>)
//   compose / comp   right-to-left composition  ((compose f g) x) => (f (g x))
//   pipe / flow      left-to-right composition   ((pipe f g) x)    => (g (f x))
//
// CONCEPTUAL SIBLING — the `(:key obj)` keyword accessor. It belongs to the same
// polyglot principle (Clojure-style keyword-as-accessor) and threads beautifully
// with this family: (->> p :versions last :state). It is NOT defined here because
// it is HOST-level syntax dispatch — `Environment.get` returns a JS pluck closure
// for any `:`-prefixed symbol (membrane.ts does the provenance-stamped read), so
// it cannot live in a scheme prelude without lifting dispatch out of the env. The
// dispatch stays in `Environment.get`; this pack is its documented conceptual home.
//
// Wiring-only (no resources) → pause-trivial. NOTE: scoped to the self-contained
// idiom family — cut/cute (which need gensym + JS interop) ship as SRFI-26 instead.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `POLYGLOT_SCM` and
// concatenates it, so this module is the sole definition site. It used to be
// byte-duplicated inline in bootstrap.ts; the docstrings travelled here with the code.

import { EnvCapability } from "./capability.js";

export const POLYGLOT_SCM = `
;; -----------------------------------------------------------------------------
;; Threading & composition (polyglot)
;; -----------------------------------------------------------------------------
;; LLMs and humans reach for whichever Lisp/FP idiom they already know — the
;; same reason :key accessors exist. So accept the whole family rather than
;; force one dialect:
;;   ->  / ~>    thread the value as the FIRST argument  (Clojure -> , Racket ~>)
;;   ->> / ~>>   thread the value as the LAST argument    (Clojure ->>, Racket ~>>)
;;   compose / comp   right-to-left composition  ((compose f g) x) => (f (g x))
;;   pipe / flow      left-to-right composition   ((pipe f g) x)    => (g (f x))
;; Keyword accessors are first-class functions, so (->> p :versions last :state)
;; threads a value while (compose :state last :versions) names the pipeline.

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

/** The polyglot idiom pack (threading & composition). Prelude-only module-singleton capability. */
export default new EnvCapability("scheme/polyglot", { prelude: POLYGLOT_SCM });
