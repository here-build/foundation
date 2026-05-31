;; _util.scm — the custdev suite's little "stdlib": pure helpers over the
;; runtime preamble. `(require "_util.scm")` spills these defines like config.scm.

;; Join items with a separator. Variadic, separator first, and any list
;; argument is flattened (one level) — so a (map …) result splices in inline
;; instead of being wrapped. The "map a function over a list, then glue" shape
;; recurs all over the suite (persona blocks, reaction transcripts, cache keys).
;;   (string-concat "\n" (map render xs))   spliced list   → "r1\nr2\nr3"
;;   (string-concat ", " a b c)             loose scalars  → "a, b, c"
;;   (string-concat "" (map :id xs))        sep "" = concat → "id1id2id3"
(define (string-concat sep . items)
  (join sep
    (apply append
      (map (lambda (x) (if (or (pair? x) (null? x)) x (list x))) items))))

(define (min-int a b) (if (< a b) a b))
