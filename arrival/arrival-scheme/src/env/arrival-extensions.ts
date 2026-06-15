// @here.build/arrival-scheme/arrival-extensions — arrival core extensions pack.
//
// The non-R7RS, non-SRFI, non-polyglot procedures that arrival adds on top of
// the portable Scheme base. All host-interop or arrival-specific:
//   • symbol/string conversion (symbol->string / string->symbol / %as.data)
//   • sort (Scheme quicksort) · unary/binary curry wrappers · tree-map
//   • pair utilities (pair-map / nth-pair)
//   • type predicates (iterator? / regex? / key? / …)
//   • object conversion (alist->object / object->alist)
//   • value utilities (value / native.number / …)
//   • aliases (string-join / string-split) · symbol-append
//   • arrival safe head accessors (first? / first-or) + the Ramda-override remove
//
// The truly-irreducible core (essential constants, the purity doors, the
// syntax-binding macros, the --> / .. interop macros and their helpers) stays
// inline in bootstrap.ts because the later packs expand against it at load time.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `ARRIVAL_EXTENSIONS_SCM`
// and concatenates it, so this module is the sole definition site.
import { EnvCapability } from "./capability.js";

export const ARRIVAL_EXTENSIONS_SCM = `
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
;; Arrival safe head accessors + Ramda-override remove (core residents)
;; -----------------------------------------------------------------------------
;; The dominant avoidable crash in generated Scheme is (car (filter …)) on an empty
;; match — (car '()) throws. These give a head accessor that CANNOT crash. The rest
;; of the SRFI-1 surface now lives in env/srfi/srfi-1.ts; these stay in core because
;; they are arrival-specific (crash-avoidance) or exist to shadow the Ramda spread.
;;
;; first? — head of a list, or #f when empty. (first? '()) => #f, never a crash. The
;; blessed safe accessor that makes (car (filter …)) unnecessary.
(define (first? xs) (if (pair? xs) (car xs) #f))
;; first-or — head of a list, or a supplied default when empty.
(define (first-or xs default) (if (pair? xs) (car xs) default))

;; remove — SRFI-1: keep elements that DON'T satisfy pred. Defined (and whitelisted) so
;; it overrides the Ramda remove spread into the sandbox env, whose curried semantics
;; returned null for this call shape.
(define (remove pred xs)
  (filter (lambda (x) (not (pred x))) xs))
`;

export default new EnvCapability("arrival/core-extensions", { prelude: ARRIVAL_EXTENSIONS_SCM });
