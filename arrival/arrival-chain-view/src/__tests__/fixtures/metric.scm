;; The task's metric: 1 if the predicted label matches the expected one
;; (case-insensitive), else 0. Required by gepa.scm — `require` of a .scm
;; spills its defines (load semantics), so `metric` becomes available directly.
(define (metric prediction expected)
  (if (string-ci=? prediction expected) 1 0))
