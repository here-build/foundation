// SRFI-43 — vector library (pure ops). Scheme-bootstrap capability. Source mirrors arrival-scheme/src/bootstrap.ts.
import { EnvCapability } from "../capability.js";

export default new EnvCapability("scheme/srfi-43", {
  prelude: `
(define (vector-fold kons knil vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0) (acc knil))
      (if (= i n) acc
          (loop (+ i 1) (kons acc (vector-ref vec i)))))))
(define (vector-fold-right kons knil vec)
  (let loop ((i (- (vector-length vec) 1)) (acc knil))
    (if (< i 0) acc
        (loop (- i 1) (kons acc (vector-ref vec i))))))
(define (vector-count pred vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0) (c 0))
      (if (= i n) c
          (loop (+ i 1) (if (pred (vector-ref vec i)) (+ c 1) c))))))
(define (vector-index pred vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0))
      (cond ((= i n) #f)
            ((pred (vector-ref vec i)) i)
            (else (loop (+ i 1)))))))
(define (vector-binary-search vec value cmp)
  (let loop ((lo 0) (hi (- (vector-length vec) 1)))
    (if (> lo hi) #f
        (let* ((mid (quotient (+ lo hi) 2))
               (c (cmp (vector-ref vec mid) value)))
          (cond ((= c 0) mid)
                ((< c 0) (loop (+ mid 1) hi))
                (else (loop lo (- mid 1))))))))
(define (vector-empty? vec) (= (vector-length vec) 0))
(define (vector-any pred vec)
  (let ((n (vector-length vec)))
    (let loop ((i 0))
      (if (= i n) #f
          (let ((r (pred (vector-ref vec i))))
            (if r r (loop (+ i 1))))))))
(define (vector-every pred vec)
  (let ((n (vector-length vec)))
    (if (= n 0) #t
        (let loop ((i 0))
          (let ((r (pred (vector-ref vec i))))
            (cond ((not r) #f)
                  ((= i (- n 1)) r)
                  (else (loop (+ i 1)))))))))
`,
});
