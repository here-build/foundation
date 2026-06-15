// @here.build/arrival-scheme/arrival-extensions — arrival core extensions pack.
//
// The non-R7RS, non-SRFI, non-polyglot procedures that arrival adds on top of
// the portable Scheme base. All host-interop or arrival-specific:
//   • symbol/string conversion (symbol->string / string->symbol / %as.data)
//   • sort (Scheme quicksort) · unary/binary curry wrappers · tree-map
//   • pair utilities (pair-map / nth-pair)
//   • type predicates (regex? / key? / …)
//   • aliases (string-join / string-split) · symbol-append
//   • arrival safe head accessors (first? / first-or) + the Ramda-override remove
//
// The truly-irreducible core (essential constants, the purity doors, the
// syntax-binding macros, the --> / .. interop macros and their helpers) stays
// inline in core (`core.ts`) because the later packs expand against it at load time.
//
// SINGLE SOURCE: `base-packs.ts` assembles `ARRIVAL_EXTENSIONS_SCM`
// and evals it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "./capability.js";
import { SchemeSymbol } from "../SchemeSymbol.js";
import { typecheck } from "../utils/typecheck.js";

export const ARRIVAL_EXTENSIONS_SCM = `
;; symbol->string / string->symbol are native (below the membrane) — see the
;; symbols block at the bottom of this module.

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
;; regex? is native (below the membrane) — see the symbols block below.

(define (key? symbol)
  (and (symbol? symbol) (string=? (substring (symbol->string symbol) 0 1) ":")))

(define (key->string symbol)
  (if (key? symbol)
      (substring (symbol->string symbol) 1)))

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

// Native symbols, below the membrane: these touch the SchemeSymbol / RegExp host
// types directly, so they live in TS rather than reaching back across the membrane
// from Scheme (the `.` / `new` / `-->` host-interop the rest of this sweep removes).
// `string->symbol`'s old `%as.data` mark was vestigial — it set a string `data`
// property, but the evaluator's data mark is the `__data__` symbol (evaluator.ts).
const symbols = {
  "symbol->string": {
    fn: (s: unknown): string => {
      typecheck("symbol->string", s, "symbol");
      const name = (s as SchemeSymbol).__name__;
      return typeof name === "string" ? name : (name as symbol).toString();
    },
    type: "(s: symbol): SStr",
  },
  "string->symbol": {
    fn: (s: unknown): SchemeSymbol => {
      typecheck("string->symbol", s, "string");
      return new SchemeSymbol(String(s));
    },
    type: "(s: SStr): symbol",
  },
  "regex?": {
    fn: (x: unknown): boolean => x instanceof RegExp,
    type: "(x: unknown): boolean",
  },
};

export default new EnvCapability("arrival/core-extensions", { symbols, prelude: ARRIVAL_EXTENSIONS_SCM });
