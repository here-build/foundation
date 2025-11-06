(test "strings: sensitive"
  (lambda (t)
    (test-specs (string=? #t "foo" "foo")
                (string<=? #t "foo" "foo")
                (string>=? #t "foo" "foo")

                (string=? #f "foo" "fooo")
                (string<? #t "foo" "goo")
                (string<=? #t "foo" "goo")
                (string>? #t "goo" "foo")
                (string>=? #t "goo" "foo")

                (string>? #t "1234" "123")
                (string>? #t "124" "123")
                (string>=? #t "124" "123")
                (string<? #t "123" "124")
                (string<=? #t "123" "124"))))


(test "strings: insensitive"
  (lambda (t)
    (test-specs (string-ci=? #t "foo" "Foo")
                (string-ci<=? #t "foO" "Foo")
                (string-ci>=? #t "foO" "Foo")

                (string-ci=? #f "foO" "foOo")

                (string-ci<? #t "Foo" "goo")
                (string-ci<? #t "foo" "Goo")
                (string-ci<=? #t "Foo" "goo")
                (string-ci>? #t "go)" "Foo")
                (string-ci>=? #t "go)" "Foo")

                (string-ci>? #t "1234" "123")
                (string-ci>? #t "124" "123")
                (string-ci>=? #t "124" "123")
                (string-ci<? #t "123" "124")
                (string-ci<=? #t "123" "124"))))

