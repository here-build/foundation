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
// MEMBER ACCESS — the polyglot read protocol is part of this family. `@` / `@?` /
// `@keys` (the explicit read/has/keys surface) and `(:key obj)` (the keyword
// accessor, Clojure-style) are TWO SYNTAXES over ONE interop read — Graal's
// `InteropLibrary.readMember` — implemented as `readMember`/`hasMember`/`memberKeys`
// in membrane.ts. They are origin-agnostic: a dict, a membrane-exposed foreign
// value, and an array all read the same way (arrival is a polyglot runtime, not a
// host with a fenced guest). They thread with the idioms here: (->> p :versions
// last :state). The reads are NOT in this prelude because they are native
// member-access primitives — `@` is a base binding, a `:`-prefixed symbol resolves
// to a pluck closure in `Environment.get` — but both bottom out in the same
// membrane core. This pack is their conceptual home; lifting the *definition* onto
// the capability is the open mechanical question (a membrane primitive can't be
// rosetta-wrapped), tracked with the sandbox→pack migration.
//
// Wiring-only (no resources) → pause-trivial. NOTE: scoped to the self-contained
// idiom family — cut/cute (which need gensym + JS interop) ship as SRFI-26 instead.
//
// SINGLE SOURCE: `base-packs.ts` assembles `POLYGLOT_SCM` and
// evals it (via initBridge's assembleEnv), so this module is the sole definition site.

import { EnvCapability } from "./capability.js";
import { keywordAccessorResolver, readMember, hasMember, memberKeys } from "../membrane.js";

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

/** The polyglot idiom pack — the full member-access surface plus the threading family:
 *   • `@` / `@?` / `@keys` — the explicit member read/has/keys. RAW `{ value }` bindings
 *     (env.set, NOT defineRosetta): they are membrane PRIMITIVES and must not be routed
 *     through the membrane they implement.
 *   • `:key` — the keyword accessor, the `@`-alias, contributed as a catchall `resolver`.
 *   • `-> / ->> / compose / pipe / …` — threading & composition (prelude).
 *  Module-singleton capability; `@`/`:key` bottom out in one `readMember` (membrane.ts). */
// IMPORT-ORDER SAFETY: `membrane.ts` is a heavy module (it pulls the evaluator) that
// can be MID-INITIALIZATION when this capability's spec object is evaluated — the
// assembly path imports it via `base-packs → polyglot → membrane → evaluator → …`, a
// cycle. Reading `readMember` / `keywordAccessorResolver` at module-eval time would
// freeze the TDZ `undefined` into the spec; assembly would then `set("@", undefined)`
// and push an undefined resolver. So defer every membrane read to APPLY time (when
// `initBridge` assembles, all modules are loaded): `symbols` uses the builder form,
// and the resolver delegates through a stable wrapper whose `resolve` reads the live
// `keywordAccessorResolver` binding only when called.
export default new EnvCapability("scheme/polyglot", {
  prelude: POLYGLOT_SCM,
  resolvers: [{ id: "keyword-accessor", resolve: (name: string) => keywordAccessorResolver.resolve(name) }],
  symbols: () => ({
    "@": { value: readMember },
    "@?": { value: hasMember },
    "@keys": { value: memberKeys },
  }),
});
