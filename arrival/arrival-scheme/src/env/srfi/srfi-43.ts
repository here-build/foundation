// SRFI-43 — vector library (pure ops). Scheme-bootstrap capability.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `SRFI43_SCM` and
// concatenates it, so this module is the sole definition site. It used to be
// byte-duplicated inline in bootstrap.ts; the docstrings travelled here with the code.
import { EnvCapability } from "../capability.js";

export const SRFI43_SCM = `
;; ============ SRFI-43 (vector library — pure ops only; arrival vectors are immutable) ============
;; vector-fold — left fold over a vector; (kons acc elt) folded across indices 0..n-1.
(define (vector-fold kons knil vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0) (acc knil))
      (if (= i n) acc
          (loop (+ i 1) (kons acc (vector-ref vec i)))))))

;; vector-fold-right — right fold over a vector; (kons acc elt) across indices n-1..0.
(define (vector-fold-right kons knil vec)
  (let loop ((i (- (vector-length vec) 1)) (acc knil))
    (if (< i 0) acc
        (loop (- i 1) (kons acc (vector-ref vec i))))))

;; vector-count — number of indices where (pred elt) is truthy.
(define (vector-count pred vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0) (c 0))
      (if (= i n) c
          (loop (+ i 1) (if (pred (vector-ref vec i)) (+ c 1) c))))))

;; vector-index — first index where (pred elt) is truthy, else #f.
(define (vector-index pred vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0))
      (cond ((= i n) #f)
            ((pred (vector-ref vec i)) i)
            (else (loop (+ i 1)))))))

;; vector-binary-search — index of value equal under (cmp elt value)=0 in sorted vec, else #f.
(define (vector-binary-search vec value cmp)
  (let loop ((lo 0) (hi (- (vector-length vec) 1)))
    (if (> lo hi) #f
        (let* ((mid (quotient (+ lo hi) 2))
               (c (cmp (vector-ref vec mid) value)))
          (cond ((= c 0) mid)
                ((< c 0) (loop (+ mid 1) hi))
                (else (loop lo (- mid 1))))))))

;; vector-empty? — #t iff the vector has length 0.
(define (vector-empty? vec) (= (vector-length vec) 0))

;; vector-any — first truthy (pred elt), scanning left to right, else #f.
(define (vector-any pred vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0))
      (if (= i n) #f
          (let ((r (pred (vector-ref vec i))))
            (if r r (loop (+ i 1))))))))

;; vector-every — last (pred elt) if all truthy, else #f (short-circuits on #f).
(define (vector-every pred vec)
  (let ((n (vector-length vec)))
    (if (= n 0) #t
        (let loop ((i 0))
          (let ((r (pred (vector-ref vec i))))
            (cond ((not r) #f)
                  ((= i (- n 1)) r)
                  (else (loop (+ i 1)))))))))
`;

export default new EnvCapability("scheme/srfi-43", { prelude: SRFI43_SCM });
