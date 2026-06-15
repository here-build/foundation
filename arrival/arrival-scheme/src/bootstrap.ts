/**
 * Bootstrap Scheme Code
 *
 * This module contains the essential Scheme macros and functions
 * that cannot be implemented in TypeScript (primarily macros).
 *
 * Previously loaded from lib/bootstrap.scm, now embedded directly
 * for faster startup and no file I/O dependency.
 *
 * SRFI bodies live in their own observable modules (src/env/srfi/*, src/env/polyglot.ts)
 * as exported `*_SCM` consts; BOOTSTRAP_SCHEME concatenates them so each SRFI has a
 * single definition site. Non-SRFI core stays inline below.
 */

import { POLYGLOT_SCM } from "./env/polyglot.js";
import { R7RS_SCM } from "./env/r7rs.js";
import { ARRIVAL_EXTENSIONS_SCM } from "./env/arrival-extensions.js";
import { SRFI1_SCM } from "./env/srfi/srfi-1.js";
import { SRFI2_SCM } from "./env/srfi/srfi-2.js";
import { SRFI8_SCM } from "./env/srfi/srfi-8.js";
import { SRFI26_SCM } from "./env/srfi/srfi-26.js";
import { SRFI43_SCM } from "./env/srfi/srfi-43.js";
import { SRFI128_SCM } from "./env/srfi/srfi-128.js";
import { SRFI189_SCM } from "./env/srfi/srfi-189.js";

export const BOOTSTRAP_SCHEME = `
;; Essential constants
(define true #t)
(define false #f)
(define NaN +nan.0)

;; =============================================================================
;; PURITY — what arrival omits, and why.
;; -----------------------------------------------------------------------------
;; arrival is PURE DATAFLOW, not general Scheme. Two whole families are omitted
;; BY DESIGN, because arrival's reason to exist is value-level provenance: every
;; value carries the lineage of where it was constructed, and the MCP/trace
;; engine reads it. Lineage is sound only if values are immutable and evaluation
;; is pure. So:
;;   • DYNAMICS (call/cc, dynamic-wind, make-parameter/parameterize,
;;     delay/force/make-promise) tie a value's identity to WHEN/WHERE control
;;     re-enters — not to where it was built. Omitted.
;;   • WRITING METHODS (set-car!/set-cdr!/append!, vector/string/bytevector
;;     mutators) change a value after construction, falsifying its lineage.
;;     Every entity is frozen by design. Omitted.
;; These are not missing features — they are what HAD to be excluded for the
;; provenance engine to be true. Each is a DOOR (errors-as-doors): it names the
;; omission, the reason, and the supported alternative. The host primitive
;; %purity-door throws the typed PurityError (telemetry); the LIST lives here.
;; See docs/plan-2026-06-11-purity-pass.md.

;; -- Writing methods: every entity is frozen by design ------------------------
(define-macro (set-car! . _)
  '(%purity-door "set-car!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (cons / list)"))
(define-macro (set-cdr! . _)
  '(%purity-door "set-cdr!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (cons / list)"))
(define-macro (append! . _)
  '(%purity-door "append!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (append, which builds a fresh list)"))
(define-macro (vector-set! . _)
  '(%purity-door "vector-set!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (vector-map / vector-copy / a fresh vector)"))
(define-macro (vector-fill! . _)
  '(%purity-door "vector-fill!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (make-vector with the fill / vector-map)"))
(define-macro (vector-copy! . _)
  '(%purity-door "vector-copy!" "every value is frozen by design — mutating its destination would falsify the provenance lineage it carries" "construct a new value (vector-copy returns a fresh vector)"))
(define-macro (string-set! . _)
  '(%purity-door "string-set!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (string-append / substring / a fresh string)"))
(define-macro (string-fill! . _)
  '(%purity-door "string-fill!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (make-string with the fill)"))
(define-macro (string-copy! . _)
  '(%purity-door "string-copy!" "every value is frozen by design — mutating its destination would falsify the provenance lineage it carries" "construct a new value (string-copy returns a fresh string)"))
(define-macro (bytevector-u8-set! . _)
  '(%purity-door "bytevector-u8-set!" "every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries" "construct a new value (bytevector-copy / a fresh bytevector)"))
(define-macro (bytevector-copy! . _)
  '(%purity-door "bytevector-copy!" "every value is frozen by design — mutating its destination would falsify the provenance lineage it carries" "construct a new value (bytevector-copy returns a fresh bytevector)"))

;; -- Dynamics: a value's identity must root at construction -------------------
(define-macro (call/cc . _)
  '(%purity-door "call/cc" "non-local re-entry severs value provenance — there is no single construction site to root lineage at" "for early exit use guard / raise (R7RS section 6.11, supported)"))
(define-macro (call-with-current-continuation . _)
  '(%purity-door "call-with-current-continuation" "non-local re-entry severs value provenance — there is no single construction site to root lineage at" "for early exit use guard / raise (R7RS section 6.11, supported)"))
(define-macro (dynamic-wind . _)
  '(%purity-door "dynamic-wind" "degenerate without call/cc, and its before/after extent is dynamic state the dataflow engine cannot linearize" "for teardown use (guard (e (#t (cleanup) (raise e))) ...)"))
(define-macro (make-parameter . _)
  '(%purity-door "make-parameter" "dynamic binding ties a value's identity to call-time extent, not to where it was constructed" "pass the value explicitly / thread it through your dataflow"))
(define-macro (parameterize . _)
  '(%purity-door "parameterize" "dynamic binding ties a value's identity to call-time extent, not to where it was constructed" "pass the value explicitly / thread it through your dataflow"))
(define-macro (delay . _)
  '(%purity-door "delay" "delayed evaluation defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed" "compute the value where you need it"))
(define-macro (force . _)
  '(%purity-door "force" "delayed evaluation defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed" "compute the value where you need it"))
(define-macro (make-promise . _)
  '(%purity-door "make-promise" "delayed evaluation defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed" "compute the value where you need it"))
(define-macro (delay-force . _)
  '(%purity-door "delay-force" "delayed evaluation defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed" "compute the value where you need it"))
;; =============================================================================

;; -----------------------------------------------------------------------------
;; Syntax binding macros
;; -----------------------------------------------------------------------------
(define-macro (let-syntax vars . body)
  \`(let ,vars
     ,@(map (lambda (rule)
              \`(typecheck "let-syntax" ,(car rule) "syntax"))
            vars)
     ,@body))

(define-macro (letrec-syntax vars . body)
  \`(letrec ,vars
     ,@(map (lambda (rule)
              \`(typecheck "letrec-syntax" ,(car rule) "syntax"))
            vars)
     ,@body))

(define-macro (define-syntax name expr . rest)
  (let ((expr-name (gensym "expr-name")))
    \`(define ,name
       (let ((,expr-name ,expr))
         (typecheck "define-syntax" ,expr-name "syntax")
         ,expr-name)
       ,@rest)))

;; -----------------------------------------------------------------------------
;; Helper functions for macros
;; -----------------------------------------------------------------------------
(define (quoted-symbol? x)
   (and (pair? x) (eq? (car x) 'quote) (symbol? (cadr x)) (null? (cddr x))))

(define (single list)
  (and (pair? list) (not (cdr list))))

;; -----------------------------------------------------------------------------
;; Method chaining macro
;; -----------------------------------------------------------------------------
(define-macro (--> expr . body)
  (let ((obj (gensym "obj")))
    \`(let* ((,obj ,expr))
       ,@(map (lambda (code)
                (let* ((value (gensym "value"))
                       (name (if (quoted-symbol? code)
                                 (symbol->string (cadr code))
                                 (if (symbol? code)
                                     (symbol->string code)
                                     (if (pair? code)
                                         (symbol->string (car code))
                                         code))))
                       (accessor (if (string? name)
                                     \`(. ,obj ,@(split "." name))
                                     \`(. ,obj ,name)))
                       (call (and (pair? code) (not (quoted-symbol? code)))))
                  \`(let ((,value ,accessor))
                     ,(if call
                          \`(if (not (function? ,value))
                               (throw (string-append "--> " ,(repr name)
                                                                " is not a function"))
                               (set! ,obj (,value ,@(cdr code))))
                          \`(set! ,obj ,value)))))
              body)
       ,obj)))

;; -----------------------------------------------------------------------------
;; Dot accessor macro
;; -----------------------------------------------------------------------------
(define-macro (.. expr)
  (if (not (symbol? expr))
      expr
      (let ((parts (split "." (symbol->string expr))))
        (if (single parts)
            expr
            \`(. ,(string->symbol (car parts)) ,@(cdr parts))))))

${POLYGLOT_SCM}

${SRFI26_SCM}

${R7RS_SCM}

${ARRIVAL_EXTENSIONS_SCM}

;; ================================================================
;; SRFI libraries (pure procedures — added 2026-06-11). All exec-verified.
;; arrival is immutable by design (no vector-set!), so only PURE ops are here.
;; ================================================================
${SRFI1_SCM}
${SRFI43_SCM}

${SRFI189_SCM}
${SRFI128_SCM}

;; ============ SRFI-8 receive + SRFI-2 and-let* (expression macros) ============
;; (let-values / let*-values already live above as define-macro forms.)
${SRFI8_SCM}
${SRFI2_SCM}
`;
