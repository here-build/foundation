;; Runnable port of scripts/generate-personas-longcat.ts.
;;
;; Generates N personas across K batches. Each batch's prompt embeds
;; a one-line summary of EVERY prior persona — so the model can avoid
;; duplicating niches. Same accumulating-fold pattern as
;; enrich-distant, but per-batch produces an array, not a single
;; record.
;;
;; Wiring (via scripts/arrival-chain/configs/generate-personas.example.json):
;;   env:
;;     total-count     N personas total (e.g. 100)
;;     batch-size      per batch (e.g. 20)
;;     product-context prose used in the system prompt
;;     system-prompt   the full system prompt text (lives in env so it
;;                     can be tuned without editing the .scm)

;; ── Schema ───────────────────────────────────────────────────────────

(define PersonaSchema
  (s/object
    (s/field/string "id"          "p<N> identifier")
    (s/field/string "name"        "first name only")
    (s/field/string "oneLine"     "one-sentence summary: 'X at Y, bottlenecked on Z'")
    (s/field/string "occupation")
    (s/field/array  "pains"             (s/array "string"))
    (s/field/array  "goals"             (s/array "string"))
    (s/field/array  "jobsToBeDone"      (s/array "string"))
    (s/field/array  "currentToolStack"  (s/array "string"))
    (s/field/array  "dealbreakers"      (s/array "string"))))

(define BatchSchema (s/object (s/field/array "personas" (s/array PersonaSchema))))

;; ── Field accessor ───────────────────────────────────────────────────

;; ── Prompt construction ──────────────────────────────────────────────

(define (summary-line p)
  (string-append "- " (field p "name") " (" (field p "id") "): " (field p "oneLine")))

(define (existing-block prior)
  (apply string-append
    (map (lambda (p) (string-append (summary-line p) "\n")) prior)))

(define (batch-user-prompt start count prior)
  (if (null? prior)
    (string-append
      "Produce " (number->string count) " personas with ids p"
      (number->string start) "..p"
      (number->string (+ start (- count 1))) ". Output the JSON object.")
    (string-append
      "Already generated (" (number->string (length prior))
      " personas, do NOT duplicate their niches):\n"
      (existing-block prior)
      "\nProduce " (number->string count) " NEW personas with ids p"
      (number->string start) "..p"
      (number->string (+ start (- count 1)))
      ", occupying niches not yet covered. Output the JSON object.")))

;; ── One batch ────────────────────────────────────────────────────────

(define (generate-batch start count prior)
  (let ((result (car (infer/chat "high"
                       (list (infer/chat/system project/system-prompt)
                             (infer/chat/user   (batch-user-prompt start count prior)))
                       BatchSchema
                       (number->string start)))))   ;; cache-key by start index
    (field result "personas")))

;; ── The accumulating loop ────────────────────────────────────────────
;;
;; K batches; each new batch sees ALL prior personas in its prompt.
;; The reverse-then-cons trick keeps the accumulator forward-ordered
;; without ever building it twice.

(define (min-int a b) (if (< a b) a b))

(define (batch-counts)
  ;; Build [project/batch-size, project/batch-size, ..., remainder].
  (define (loop remaining acc)
    (if (<= remaining 0)
      (reverse acc)
      (let ((c (min-int project/batch-size remaining)))
        (loop (- remaining c) (cons c acc)))))
  (loop project/total-count '()))

(define (run-batches counts)
  (define (loop counts start prior)
    (if (null? counts)
      prior
      (let* ((c     (car counts))
             (batch (generate-batch start c prior)))
        (loop (cdr counts) (+ start c) (append prior batch)))))
  (loop counts 1 '()))

(run-batches (batch-counts))
