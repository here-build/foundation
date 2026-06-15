/**
 * Bootstrap Scheme Code
 *
 * This module contains the essential Scheme macros and functions
 * that cannot be implemented in TypeScript (primarily macros).
 *
 * Previously loaded from lib/bootstrap.scm, now embedded directly
 * for faster startup and no file I/O dependency.
 *
 * SRFI bodies live in their own observable modules (src/env/srfi/*, src/env/macros.ts)
 * as exported `*_SCM` consts; BOOTSTRAP_SCHEME concatenates them so each SRFI has a
 * single definition site. Non-SRFI core stays inline below.
 */

import { THREADING_SCM } from "./env/macros.js";
import { SRFI1_SCM } from "./env/srfi/srfi-1.js";
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

${THREADING_SCM}

${SRFI26_SCM}

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

;; -----------------------------------------------------------------------------
;; Symbol/string conversion (needs JS interop)
;; -----------------------------------------------------------------------------
(define (symbol->string s)
  (typecheck "symbol->string" s "symbol")
  ;; Use the explicit (. obj prop) accessor, NOT the obj.prop reader sugar.
  ;; The sugar resolves a symbol literally named "s.__name__" and reaches the
  ;; trampoline evaluator's env_get -> _lookupWithResolvers, which (unlike
  ;; Environment::get) does not split dot-notation, so the sugar throws
  ;; "Unbound variable s.__name__". The (. ...) special form goes through the
  ;; get resolver directly and works. symbol->string is foundational (-->,
  ;; .., the test harness macros all call it), so this unblocks ~8 lang specs.
  (let ((name (. s '__name__)))
    (if (string? name)
        name
        ((. name 'toString)))))

(define (%as.data obj)
  (if (object? obj)
      (begin
        (set-obj! obj 'data true)
        obj)))

(define (string->symbol string)
  (typecheck "string->symbol" string "string")
  (let ((symbol (new scheme.SchemeSymbol string)))
    (%as.data symbol)))

;; -----------------------------------------------------------------------------
;; List utilities that depend on Scheme features
;; -----------------------------------------------------------------------------
(define (zip . lists)
  (if (or (null? lists) (some null? lists))
      '()
      (cons (map car lists) (apply zip (map cdr lists)))))

(define (some fn . lists)
  (typecheck "some" fn "function")
  (%some fn lists))

(define (%some fn lists)
  (if (or (null? lists) (%any-null? lists))
      false
      (if (apply fn (map car lists))
          true
          (%some fn (map cdr lists)))))

(define (%any-null? lst)
  (if (null? lst)
      false
      (if (null? (car lst))
          true
          (%any-null? (cdr lst)))))

(define (every fn . lists)
  (typecheck "every" fn "function")
  (%every fn lists))

(define (%every fn lists)
  (if (or (null? lists) (%any-null? lists))
      true
      (and (apply fn (map car lists)) (%every fn (map cdr lists)))))

;; -----------------------------------------------------------------------------
;; Sorting (recursive, best in Scheme)
;; -----------------------------------------------------------------------------
(define (qsort e predicate)
  (if (or (null? e) (<= (length e) 1))
      e
      (let loop ((left '()) (right '())
                 (pivot (car e)) (rest (cdr e)))
        (if (null? rest)
            (append (append (qsort left predicate) (list pivot)) (qsort right predicate))
            (if (predicate (car rest) pivot)
                (loop (append left (list (car rest))) right pivot (cdr rest))
                (loop left (append right (list (car rest))) pivot (cdr rest)))))))

(define (sort list . rest)
  (let ((predicate (if (null? rest) <= (car rest))))
    (typecheck "sort" list "pair")
    (typecheck "sort" predicate "function")
    (qsort list predicate)))

;; -----------------------------------------------------------------------------
;; Unfold (recursive)
;; -----------------------------------------------------------------------------
(define (unfold fn init)
  (typecheck "unfold" fn "function")
  (let iter ((pair (fn init)) (result '()))
    (if (not pair)
        (reverse result)
        (iter (fn (cdr pair)) (cons (car pair) result)))))

;; -----------------------------------------------------------------------------
;; Higher-order function wrappers using curry
;; -----------------------------------------------------------------------------
(define unary (curry n-ary 1))
(define binary (curry n-ary 2))

;; -----------------------------------------------------------------------------
;; Tree operations
;; -----------------------------------------------------------------------------
(define (tree-map f tree)
  (if (pair? tree)
      (cons (tree-map f (car tree)) (tree-map f (cdr tree)))
      (f tree)))

;; -----------------------------------------------------------------------------
;; Pair utilities
;; -----------------------------------------------------------------------------
(define (pair-map fn seq-list)
  (let iter ((seq-list seq-list) (result '()))
    (if (null? seq-list)
        result
        (if (and (pair? seq-list) (pair? (cdr seq-list)))
            (let* ((first (car seq-list))
                   (second (cadr seq-list))
                   (value (fn first second)))
              (if (null? value)
                  (iter (cddr seq-list) result)
                  (iter (cddr seq-list) (cons value result))))))))

(define (nth-pair l k)
  (%nth-pair "nth-pair" l k))

;; -----------------------------------------------------------------------------
;; Type predicates
;; -----------------------------------------------------------------------------
(define (iterator? x)
   (and (object? x) (procedure? (. x Symbol.iterator))))

(define (regex? x)
  (== (--> (type x) (cmp "regex")) 0))

(define (key? symbol)
  (and (symbol? symbol) (== (--> (substring (symbol->string symbol) 0 1) (cmp ":")) 0)))

(define (key->string symbol)
  (if (key? symbol)
      (substring (symbol->string symbol) 1)))

(define (gensym? value)
  (and (symbol? value) (--> value (is_gensym))))

(define (environment? obj)
  (instanceof scheme.Environment obj))

(define (defmacro? obj)
  (and (macro? obj) (. obj 'defmacro)))

(define (native-symbol? x)
  (and (string=? (type x) "symbol") (not (symbol? x))))

;; -----------------------------------------------------------------------------
;; Object conversion
;; -----------------------------------------------------------------------------
(define (alist->object alist)
  (if (pair? alist)
      (alist.to_object)
      (alist->object (new scheme.Pair #void '()))))

(define (object->alist object)
  (typecheck "object->alist" object "object")
  (vector->list (--> (Object.entries object)
                     (map (lambda (arr)
                            (apply cons (vector->list arr)))))))

;; alist->assign was a destructive alist merge (set-cdr! + append!). It had zero
;; callers and was the only internal user of those mutators — removed by the
;; purity invariant (it cannot exist without mutation; the pure equivalent is to
;; construct a fresh alist).

;; -----------------------------------------------------------------------------
;; Value utilities
;; -----------------------------------------------------------------------------
(define (native.number x)
  (if (number? x)
      (value x)
      x))

(define (value obj)
  (if (eq? obj '())
      #void
      (if (number? obj)
          ((. obj "valueOf"))
          obj)))

;; -----------------------------------------------------------------------------
;; Environment utilities
;; -----------------------------------------------------------------------------
(define (interaction-environment)
  **interaction-environment**)

(define (bound? x . rest)
  (let ((env (if (null? rest) (interaction-environment) (car rest))))
    (try (begin
           (--> env (get x))
           true)
         (catch (e)
                false))))

(define (environment-bound? env x)
  (typecheck "environment-bound?" env "environment" 1)
  (typecheck "environment-bound?" x "symbol" 2)
  (bound? x env))

;; -----------------------------------------------------------------------------
;; Aliases
;; -----------------------------------------------------------------------------
(define string-join join)
(define string-split split)

;; -----------------------------------------------------------------------------
;; Symbol operations
;; -----------------------------------------------------------------------------
(define (symbol-append . rest)
   (string->symbol (apply string-append (map symbol->string rest))))

;; -----------------------------------------------------------------------------
;; SRFI-1 (the missing third) + a blessed safe head accessor
;; -----------------------------------------------------------------------------
;; The dominant avoidable crash in generated Scheme is (car (filter …)) on an empty
;; match — (car '()) throws. These give a head accessor that CANNOT crash, plus the
;; SRFI-1 procedures that retire the hand-rolled dedupe/member?/index-map helpers.
;;
;; first? — head of a list, or #f when empty. (first? '()) => #f, never a crash. The
;; blessed safe accessor that makes (car (filter …)) unnecessary.
(define (first? xs) (if (pair? xs) (car xs) #f))
;; first-or — head of a list, or a supplied default when empty.
(define (first-or xs default) (if (pair? xs) (car xs) default))

;; iota — (iota count [start step]); a list of count integers from start by step.
(define (iota count . rest)
  (let ((start (if (null? rest) 0 (car rest)))
        (step (if (or (null? rest) (null? (cdr rest))) 1 (cadr rest))))
    (let loop ((i 0) (acc '()))
      (if (>= i count) (reverse acc)
          (loop (+ i 1) (cons (+ start (* i step)) acc))))))

;; delete-duplicates — order-preserving dedup by equal?. Retires the O(n²) hand-rolled
;; dedupe reinvented across the pipeline.
(define (delete-duplicates xs)
  (let loop ((xs xs) (seen '()) (acc '()))
    (if (null? xs) (reverse acc)
        (if (member (car xs) seen)
            (loop (cdr xs) seen acc)
            (loop (cdr xs) (cons (car xs) seen) (cons (car xs) acc))))))

;; filter-map — map then drop the falsy results, in one pass the model can't mismatch.
(define (filter-map fn . lists)
  (filter (lambda (x) x) (apply map fn lists)))

;; count — how many element-tuples satisfy pred.
(define (count pred . lists)
  (length (filter (lambda (b) b) (apply map pred lists))))

;; list-index — index of the first element-tuple satisfying pred, or #f.
(define (list-index pred . lists)
  (let loop ((i 0) (ls lists))
    (if (some null? ls) #f
        (if (apply pred (map car ls)) i
            (loop (+ i 1) (map cdr ls))))))

;; append-map — map then append the result lists.
(define (append-map fn . lists)
  (apply append (apply map fn lists)))

;; remove — SRFI-1: keep elements that DON'T satisfy pred. Defined (and whitelisted) so
;; it overrides the Ramda remove spread into the sandbox env, whose curried semantics
;; returned null for this call shape.
(define (remove pred xs)
  (filter (lambda (x) (not (pred x))) xs))

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

;; receive (SRFI-8) — bind the values of the producer expr to formals over body.
(define-syntax receive
  (syntax-rules ()
    ((_ formals expr body ...)
     (call-with-values (lambda () expr) (lambda formals body ...)))))

;; and-let* (SRFI-2) — sequential AND with binding. Claw (var expr) binds+tests var;
;; claw (expr) is a bare guard. Any #f short-circuits the whole form to #f.
(define-syntax and-let*
  (syntax-rules ()
    ((_ ()) #t)
    ((_ () body ...) (begin body ...))
    ((_ ((var expr) claws ...) body ...)
     (let ((var expr)) (if var (and-let* (claws ...) body ...) #f)))
    ((_ ((expr) claws ...) body ...)
     (if expr (and-let* (claws ...) body ...) #f))))

`;
