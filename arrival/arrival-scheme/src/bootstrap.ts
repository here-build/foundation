/**
 * Bootstrap Scheme Code
 *
 * This module contains the essential Scheme macros and functions
 * that cannot be implemented in TypeScript (primarily macros).
 *
 * Previously loaded from lib/bootstrap.scm, now embedded directly
 * for faster startup and no file I/O dependency.
 */

export const BOOTSTRAP_SCHEME = `
;; Essential constants
(define true #t)
(define false #f)
(define NaN +nan.0)

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

(define (%else-literal? obj)
  (and (symbol? obj)
       (or (eq? obj 'else)
           (eq? (--> (new lips.SchemeString (obj.literal))
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

(define (raise obj)
  (if (null? *current-exception-handlers*)
      (%raise obj)
      (let ((handler (car *current-exception-handlers*)))
        (handler obj)
        (%raise (make-error-object "exception handler returned for non-continuable exception")))))

(define (raise-continuable obj)
  (if (null? *current-exception-handlers*)
      (%raise obj)
      (let ((handler (car *current-exception-handlers*)))
        (handler obj))))

(define (with-exception-handler handler thunk)
  (let ((old-handlers *current-exception-handlers*))
    (set! *current-exception-handlers* (cons handler old-handlers))
    (try
      (let ((result (thunk)))
        (set! *current-exception-handlers* old-handlers)
        result)
      (catch (e)
        (set! *current-exception-handlers* old-handlers)
        (raise e)))))

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
  (let ((name s.__name__))
    (let ((str (if (string? name)
                   name
                   (name.toString))))
      (str.freeze)
      str)))

(define (%as.data obj)
  (if (object? obj)
      (begin
        (set-obj! obj 'data true)
        obj)))

(define (string->symbol string)
  (typecheck "string->symbol" string "string")
  (let ((symbol (new lips.SchemeSymbol string)))
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
  (instanceof lips.Environment obj))

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
      (alist->object (new lips.Pair #void '()))))

(define (object->alist object)
  (typecheck "object->alist" object "object")
  (vector->list (--> (Object.entries object)
                     (map (lambda (arr)
                            (apply cons (vector->list arr)))))))

(define (alist->assign desc . sources)
  (for-each (lambda (source)
              (for-each (lambda (pair)
                          (let* ((key (car pair))
                                 (value (cdr pair))
                                 (d-pair (assoc key desc)))
                            (if (pair? d-pair)
                                (set-cdr! d-pair value)
                                (append! desc (list pair)))))
                        source))
            sources)
  desc)

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
`;
