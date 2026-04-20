;;; (chibi test) compatible test library for LIPS Scheme
;;;
;;; This implements the core testing macros from Chibi Scheme's test library
;;; to enable running R7RS compliance tests in LIPS.
;;;
;;; Implements: test, test-begin, test-end, test-assert, test-equal,
;;;             test-error, test-values, test-group
;;;
;;; Copyright (c) 2024 here.build
;;; Released under MIT license

;; -----------------------------------------------------------------------------
;; R7RS compliance helpers
;; Define equal? and eqv? if not present (LIPS only provides eq?)
;; -----------------------------------------------------------------------------

;; equal? - recursive structural equality
;; NOTE: LIPS uses array? instead of vector?, and doesn't have vector-ref
;; We use list->array/array->list for comparison
(define (equal? a b)
  "(equal? a b)

   R7RS structural equality. Returns #t if a and b have the same structure
   and contents."
  (cond
    ;; Same object
    ((eq? a b) #t)
    ;; Both pairs - compare car and cdr recursively
    ((and (pair? a) (pair? b))
      (and (equal? (car a) (car b))
        (equal? (cdr a) (cdr b))))
    ;; Both arrays (LIPS vectors) - compare by converting to list
    ((and (array? a) (array? b))
      (equal? (array->list a) (array->list b)))
    ;; Both strings - string comparison
    ((and (string? a) (string? b))
      (string=? a b))
    ;; Numbers - use numeric ==
    ;; NOTE: LIPS uses == instead of =
    ((and (number? a) (number? b))
      (== a b))
    ;; Default - use eq?
    (else (eq? a b))))

;; eqv? - equivalence for atoms
;; NOTE: LIPS doesn't have char?, char=?, exact?, nan?
;; Simplified implementation using eq? for most cases
(define (eqv? a b)
  "(eqv? a b)

   R7RS equivalence predicate. More discriminating than equal? but
   less than eq?. Primarily differs in number handling."
  (cond
    ;; Same object
    ((eq? a b) #t)
    ;; Numbers - use numeric equality
    ;; NOTE: LIPS uses == instead of =
    ((and (number? a) (number? b))
      (== a b))
    ;; NOTE: For strings, R7RS says eqv? behavior is unspecified.
    ;; We use eq? (object identity) to match common implementations
    ;; where (eqv? "" "") => #f (different string objects).
    ;; Default - use eq?
    (else (eq? a b))))

;; -----------------------------------------------------------------------------
;; Test state management
;; -----------------------------------------------------------------------------

(define *test-groups* '())
(define *current-test-group* #f)
(define *test-pass-count* 0)
(define *test-fail-count* 0)
(define *test-skip-count* 0)
(define *test-errors* '())

(define (test-reset!)
  "Reset all test state"
  (set! *test-groups* '())
  (set! *current-test-group* #f)
  (set! *test-pass-count* 0)
  (set! *test-fail-count* 0)
  (set! *test-skip-count* 0)
  (set! *test-errors* '()))

;; -----------------------------------------------------------------------------
;; Test comparator - default uses equal?
;; -----------------------------------------------------------------------------

(define *current-test-comparator* equal?)

(define (current-test-comparator)
  *current-test-comparator*)

(define (current-test-comparator-set! proc)
  (set! *current-test-comparator* proc))

;; -----------------------------------------------------------------------------
;; Approximate equality for inexact numbers
;; -----------------------------------------------------------------------------

(define *test-epsilon* 1 e-10)

;; NOTE: LIPS doesn't have inexact?, complex?, real-part, imag-part
;; Simplified implementation for basic number comparison
(define (test-approx-equal? a b)
  "Compare values, using approximate equality for floating point numbers"
  (cond
    ;; Both real numbers - use epsilon comparison
    ((and (real? a) (real? b))
      (let ((diff (abs (- a b))))
        (or (< diff *test-epsilon*)
          (< diff (* *test-epsilon* (max (abs a) (abs b)))))))
    ;; Fall back to equal?
    (else (equal? a b))))

;; -----------------------------------------------------------------------------
;; Test reporting hooks (can be overridden by test runner)
;; -----------------------------------------------------------------------------

(define *test-on-pass* #f)
(define *test-on-fail* #f)
(define *test-on-error* #f)
(define *test-on-group-begin* #f)
(define *test-on-group-end* #f)

(define (test-on-pass! proc) (set! *test-on-pass* proc))
(define (test-on-fail! proc) (set! *test-on-fail* proc))
(define (test-on-error! proc) (set! *test-on-error* proc))
(define (test-on-group-begin! proc) (set! *test-on-group-begin* proc))
(define (test-on-group-end! proc) (set! *test-on-group-end* proc))

;; Internal reporting
(define (report-pass name expected actual)
  (set! *test-pass-count* (+ *test-pass-count* 1))
  (if *test-on-pass*
    (*test-on-pass* name expected actual)))

(define (report-fail name expected actual)
  (set! *test-fail-count* (+ *test-fail-count* 1))
  (set! *test-errors*
    (cons (list 'fail *current-test-group* name expected actual)
      *test-errors*))
  (if *test-on-fail*
    (*test-on-fail* name expected actual)))

(define (report-error name err)
  (set! *test-fail-count* (+ *test-fail-count* 1))
  (set! *test-errors*
    (cons (list 'error *current-test-group* name err)
      *test-errors*))
  (if *test-on-error*
    (*test-on-error* name err)))

;; -----------------------------------------------------------------------------
;; test-begin / test-end - Group tests
;; -----------------------------------------------------------------------------

(define (test-begin name)
  "(test-begin name)

   Begin a new test group with the given name."
  (set! *test-groups* (cons *current-test-group* *test-groups*))
  (set! *current-test-group* name)
  (if *test-on-group-begin*
    (*test-on-group-begin* name)))

(define (test-end . args)
  "(test-end [name])

   End the current test group. Optional name is for verification."
  (let ((name (if (null? args) #f (car args))))
    (if *test-on-group-end*
      (*test-on-group-end* *current-test-group*))
    (set! *current-test-group* (car *test-groups*))
    (set! *test-groups* (cdr *test-groups*))))

;; -----------------------------------------------------------------------------
;; test-group - Convenience macro for grouped tests
;; -----------------------------------------------------------------------------

(define-macro (test-group name . body)
  "(test-group name body ...)

   Execute body within a named test group."
  `(begin
     (test-begin ,name)
     ,@body
     (test-end ,name)))

;; -----------------------------------------------------------------------------
;; Core test implementation
;; -----------------------------------------------------------------------------

(define (%test-run name expected thunk comparator expect-error?)
  "Internal test runner"
  (let ((actual #f)
         (error-caught #f)
         (error-value #f))
    ;; Execute the thunk
    (try
      (set! actual (thunk))
      (catch (e)
        (set! error-caught #t)
        (set! error-value e)))

    ;; Evaluate result
    (cond
      ;; Expected an error
      (expect-error?
        (if error-caught
          (report-pass name 'error error-value)
          (report-fail name 'error actual)))
      ;; Got unexpected error
      (error-caught
        (report-error name error-value))
      ;; Normal comparison
      ((comparator expected actual)
        (report-pass name expected actual))
      ;; Failed comparison
      (else
        (report-fail name expected actual)))))

;; -----------------------------------------------------------------------------
;; test - Main test macro (chibi-compatible)
;; -----------------------------------------------------------------------------

(define-syntax test
  (syntax-rules ()
    ;; (test expected expr)
    ((test expected expr)
      (test #f expected expr))
    ;; (test name expected expr)
    ((test name expected expr)
      (%test-run
        (if name name (repr 'expr))
        expected
        (lambda () expr)
        (current-test-comparator)
        #f))))

;; -----------------------------------------------------------------------------
;; test-equal - Test with custom comparator
;; -----------------------------------------------------------------------------

(define-syntax test-equal
  (syntax-rules ()
    ((test-equal comparator expected expr)
      (test-equal #f comparator expected expr))
    ((test-equal name comparator expected expr)
      (%test-run
        (if name name (repr 'expr))
        expected
        (lambda () expr)
        comparator
        #f))))

;; -----------------------------------------------------------------------------
;; test-assert - Test that expression is truthy
;; -----------------------------------------------------------------------------

(define-syntax test-assert
  (syntax-rules ()
    ((test-assert expr)
      (test-assert #f expr))
    ((test-assert name expr)
      (%test-run
        (if name name (repr 'expr))
        #t
        (lambda () (if expr #t #f))
        eq?
        #f))))

;; -----------------------------------------------------------------------------
;; test-not - Test that expression is falsy
;; -----------------------------------------------------------------------------

(define-syntax test-not
  (syntax-rules ()
    ((test-not expr)
      (test-not #f expr))
    ((test-not name expr)
      (%test-run
        (if name name (repr 'expr))
        #f
        (lambda () (if expr #t #f))
        eq?
        #f))))

;; -----------------------------------------------------------------------------
;; test-error - Test that expression raises an error
;; -----------------------------------------------------------------------------

(define-syntax test-error
  (syntax-rules ()
    ((test-error expr)
      (test-error #f expr))
    ((test-error name expr)
      (%test-run
        (if name name (repr 'expr))
        'error
        (lambda () expr)
        (lambda (exp act) #t)  ;; comparator ignored for errors
        #t))))

;; -----------------------------------------------------------------------------
;; test-values - Test multiple values
;; -----------------------------------------------------------------------------

(define-syntax test-values
  (syntax-rules ()
    ((test-values expected expr)
      (test-values #f expected expr))
    ((test-values name expected expr)
      (%test-run
        (if name name (repr 'expr))
        (call-with-values (lambda () expected) list)
        (lambda () (call-with-values (lambda () expr) list))
        equal?
        #f))))

;; -----------------------------------------------------------------------------
;; Test results accessors
;; -----------------------------------------------------------------------------

(define (test-failure-count) *test-fail-count*)
(define (test-pass-count) *test-pass-count*)
(define (test-skip-count) *test-skip-count*)
(define (test-errors) *test-errors*)
(define (test-total-count) (+ *test-pass-count* *test-fail-count* *test-skip-count*))

(define (test-summary)
  "Return a summary object of test results"
  (list
    (cons 'passed *test-pass-count*)
    (cons 'failed *test-fail-count*)
    (cons 'skipped *test-skip-count*)
    (cons 'total (test-total-count))
    (cons 'errors *test-errors*)))
