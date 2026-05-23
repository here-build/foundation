;; Multi-variant version of herebuild-react. K variants × N personas ×
;; M replays — pure-parallel reactions. Used when you want to compare
;; hero-text variants against the same persona pool in a single run.
;;
;; Wiring (via configs/herebuild-opus-15-run.json etc.):
;;   files:
;;     personas.json    nested-shape persona file
;;     variants.json    [{ "id": "V0", "lead": "...", "scenario": "..." }, ...]
;;   env:
;;     replays          per-cell replay count
;;     system-prompt    reaction system prompt
;;
;; Output: a list of (variant-id . reactions-by-persona) entries, where
;; reactions-by-persona is itself a list of (persona-id reaction*).

(define (state-of profile)
  (field (last (field profile "versions")) "state"))

(define ReactionSchema
  (s/object
    (s/field/string "interpretation")
    (s/field/string "verdict")
    (s/field/string "concern")))

(define (persona-summary p)
  (let ((s (state-of p)))
    (apply string-append
      (map (lambda (entry)
             (let ((label (car entry)) (k (car (cdr entry))))
               (let ((v (field s k)))
                 (if (or (null? v) (equal? v ""))
                   ""
                   (string-append label ": "
                     (if (pair? v)
                       (apply string-append (map (lambda (x) (string-append x "; ")) v))
                       v) "\n")))))
        (list (list "Name" "name")
              (list "One-line" "oneLine")
              (list "Occupation" "occupation")
              (list "Pains" "pains")
              (list "Goals" "goals")
              (list "Jobs-to-be-done" "jobsToBeDone")
              (list "Current tool stack" "currentToolStack")
              (list "Dealbreakers" "dealbreakers"))))))

(define (react-user persona variant)
  (string-append
    "PERSONA:\n" (persona-summary persona) "\n---\n"
    "You just landed on the homepage of a tool called here.build. The hero text:\n\n"
    "\"" (field variant "lead") "\"\n\n"
    "Answer in three short parts:\n"
    "(a) What does this tell you about what the product does and what it trades?\n"
    "(b) Would you keep reading, click, or bounce? Pick one and say why.\n"
    "(c) First concern, suspicion, or question now in your head?"))

(define (react-cell persona variant replay-idx)
  (car (infer/chat "high"
         (list (infer/chat/system project/system-prompt)
               (infer/chat/user   (react-user persona variant)))
         ReactionSchema
         (string-append (field variant "id") "/" (field persona "id") "/" (number->string replay-idx)))))

(define (cell-row persona variant)
  (list (field persona "id")
        (map (lambda (i) (react-cell persona variant i)) (range project/replays))))

(define (variant-row variant personas)
  (list (field variant "id")
        (map (lambda (p) (cell-row p variant)) personas)))

(require "personas.json")
(require "variants.json")

(map (lambda (v) (variant-row v (values-of personas))) variants)
