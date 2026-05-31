;; Runnable port of scripts/generate-personas-longcat.ts.
;;
;; Generates N personas across K batches. Each batch's prompt embeds
;; a one-line summary of EVERY prior persona — so the model can avoid
;; duplicating niches. Same accumulating-fold pattern as
;; enrich-distant, but per-batch produces an array, not a single
;; record.
;;
;; Wiring (config-as-code — config.scm ships per run):
;;   config.scm:
;;     config/total-count     N personas total (e.g. 100)
;;     config/batch-size      per batch (e.g. 20)
;;     config/product-context prose threaded into the prompt as {{productContext}}
;;
;; The generation system prompt is inlined in generate-personas.prompt — it's
;; stage-specific (the distinct-niche coverage axes), not a tunable shared knob.

(require "config.scm")
(require "_util.scm")   ;; string-concat + suite helpers

;; ── Prompt (.prompt = full inference unit) ───────────────────────────
;;
;; generate-personas.prompt carries the tier, the batch output schema
;; (Picoschema), and the system + user body. The generation system prompt is
;; inlined there; product context flows in as {{productContext}}. summary-line
;; stays here — it builds the prior-personas block ({{priorBlock}}) the prompt
;; embeds; the {{#if priorBlock}} branch picks first-batch vs subsequent-batch
;; wording.

(define (summary-line p)
  (string-append "- " (:name p) " (" (:id p) "): " (:oneLine p)))

(define generate (require "generate-personas.prompt"))

;; ── One batch ────────────────────────────────────────────────────────

(define (generate-batch start count prior)
  (:personas (generate (number->string start)            ;; cache-key by start index
      :productContext  config/product-context
      :priorBlock    (string-concat "\n" (map summary-line prior))
      :priorCount    (number->string (length prior))
      :count         (number->string count)
      :start         (number->string start)
      :end           (number->string (+ start (- count 1))))))

;; ── The accumulating loop ────────────────────────────────────────────
;;
;; K batches; each new batch sees ALL prior personas in its prompt.
;; The reverse-then-cons trick keeps the accumulator forward-ordered
;; without ever building it twice.

(define (batch-counts)
  ;; Build [config/batch-size, config/batch-size, ..., remainder].
  (define (loop remaining acc)
    (if (<= remaining 0)
      (reverse acc)
      (let ((c (min-int config/batch-size remaining)))
        (loop (- remaining c) (cons c acc)))))
  (loop config/total-count '()))

(define (run-batches counts)
  (define (loop counts start prior)
    (if (null? counts)
      prior
      (let* ((c     (car counts))
             (batch (generate-batch start c prior)))
        (loop (cdr counts) (+ start c) (append prior batch)))))
  (loop counts 1 '()))

(run-batches (batch-counts))
