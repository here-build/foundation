(test "std: vector-map"
      (lambda (t)

        ;; examples from R7RS spec
        (t.is (vector-map cadr '(vector (a b) (d e) (g h)))
              '(vector b e h))

        (t.is (vector-map + '(vector 1 2 3) '(vector 4 5 6 7))
              'vector (5 7 9))))

(test "std: some"
      (lambda (t)
        (t.is (some + '()) #f)
        (t.is (some odd? (list 1 2 3)) #t)
        (t.is (some odd? (list 2 4 6)) #f)))

(test "std: fold"
      (lambda (t)
        (t.is (fold * 1 (cdr (range 10))) 362880)))

(test "std: pluck"
      (lambda (t)
        (let ((name (pluck '__name__)))
          (t.is (name 'foo) "foo"))
        (let ((name (pluck "__name__")))
          (t.is (name 'foo) "foo"))
        (let ((none (pluck)))
          (t.is (none 'foo) '()))
        (let ((xy (pluck 'x 'y)))
          (t.is (xy &(:x 10 :y 20 :z 30)) &(:x 10 :y 20)))))

(test "std: predicates"
      (lambda (t)
        (t.is (regex? #/foo/) #t)
        (t.is (boolean? '()) #f)
        (t.is (boolean? #null) #f)
        (t.is (boolean? #void) #f)
        (t.is (boolean? #t) #t)
        (t.is (boolean? #f) #t)))

(test "std: find"
      (lambda (t)
        (t.is (find odd? (list 1 2 3)) 1)
        (t.is (find #/^[0-9]+$/ (list "foo" "bar" "10")) "10")
        (t.is (to.throw (find "xxx" (list 1 2 3))) true)
        (t.is (find odd? (list 0 2 4 3)) 3)
        (t.is (find odd? (list 0 2 4 6)) '())))

(test "std: typecheck"
      (lambda (t)
        (t.is (to.throw (typecheck "test" 10 (list "string"))) true)
        (t.is (try (typecheck "test" 10 (list "string") 0) (catch (e) e.message))
              "Expecting a string got number in expression `test` (argument 0)")
        (t.is (try (typecheck "test" 10 (list "string" "character") 0) (catch (e) e.message))
              "Expecting string or character got number in expression `test` (argument 0)")))

(test "std: fold/curry"
      (lambda (t)

        (define (fold-left proc knil list)
          (fold (lambda (acc elt) (proc elt acc)) knil list))

        (define (test fn)
          (t.is (procedure? fn) true)
          (t.is (fn 4) 10))

        (let ((fn (curry (curry (curry + 1) 2) 3)))
          (test fn))

        (let ((fn (fold-left curry + '(1 2 3))))
          (test fn))))

(test "std: char properties"
      (lambda (t)
        ;; function taken from book Sketchy Scheme by Nils M Holm
        (define (char-properties x)
          (apply append
                 (map (lambda (prop)
                        (cond (((car prop) x)
                               (cdr prop))
                              (else '())))
                      (list (cons char-alphabetic? '(alphabetic))
                            (cons char-numeric? '(numeric))
                            (cons char-upper-case? '(upper-case))
                            (cons char-lower-case? '(lower-case))
                            (cons char-whitespace? '(whitespace))))))

        (t.is (map char-properties '(#\C #\c #\1 #\#))
              '((alphabetic upper-case)
                (alphabetic lower-case)
                (numeric)
                ()))))


(test "std: utf8->string"
      (lambda (t)
        (t.is (utf8->string #u8(#xCE #xBB)) "λ")
        (let ((v #u8(#xCE #xBB #x41 #x41 #x41)))
           (t.is (utf8->string v 0 2) "λ")
           (t.is (utf8->string v 0 4) "λAA")
           (t.is (utf8->string v 2 4) "AA"))))

(test "std: string->utf8"
      (lambda (t)
        (t.is (string->utf8 "λ") #u8(#xCE #xBB))
        (let ((str "λAA"))
          (t.is (string->utf8 str 0 1) #u8(#xCE #xBB))
          (t.is (string->utf8 str 0 2) #u8(#xCE #xBB #x41))
          (t.is (string->utf8 str 1 3) #u8(#x41 #x41)))))

(test "std: atanh and log function"
      (lambda (t)
        ;; source: https://doc.scheme.org/surveys/ComplexLog/
        (define (atanh x)
          (/ (- (log (+ 1 x))
                (log (- 1 x)))
             2))
        (t.is (atanh -2)
              -0.5493061443340548+1.5707963267948966i)))

(test "std: Petrofsky let"
      (lambda (t)
        (t.is (let - ((n (- 1))) n) -1)))

(test "std: parameterize base"
      (lambda (t)
        (define radix
          (make-parameter
           10
           (lambda (x)
             (if (and (exact-integer? x) (<= 2 x 16))
                 x
                 (error (string-append "invalid radix " (repr x)))))))

        (define (f n) (number->string n (radix)))

        (t.is (f 12) "12")
        (t.is (parameterize ((radix 2))
                (f 12))
              "1100")))

(test "std: guard function with =>"
      (lambda (t)
        (t.is (guard (condition
                      ((assq 'a condition) => cdr)
                      ((assq 'b condition) => car))
                     (raise (list (cons 'b 23))))
              'b)))

(test "std: guard list"
      (lambda (t)
        (t.is (guard (condition
                      ((assq 'a condition) => cdr)
                      ((assq 'b condition) "error"))
                     (raise (list (cons 'b 23))))
              "error")))

(test "std: guard identity"
      (lambda (t)
        (t.is (guard (condition
                      ((assq 'a condition) => cdr)
                      ((assq 'b condition)))
                     (raise (list (cons 'b 23))))
              '(b . 23))))

(test.skip "std: equal? on same cycle"
      (lambda (t)
        (let ((x (cons 1 (cons 2 '()))))
          (set-cdr! (cdr x) x)
          (t.is (equal? x x) #t))))

(test.skip "std: equal?  on identical cycles"
      (lambda (t)
        (let ((a (list 1 2))
              (b (list 1 2)))
          (set-cdr! (cdr a) a)
          (set-cdr! (cdr b) b)
          (t.is (equal? a b) #t))))

(test "std: cond"
      (lambda (t)
        (t.is (cond (else 10)) 10)
        (t.is (cond ((zero? 0) 10) (else 20)) 10)
        (t.is (cond ((zero? 10) 10) (else 20)) 20)
        (t.is (let ((alist '((a . 10) (b . 20) (c . 30))))
                (cond ((assoc 'b alist) => cdr) (else #f)))
              20)))
