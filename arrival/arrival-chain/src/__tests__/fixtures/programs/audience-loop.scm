;; Runnable port of V's audience-loop pipeline against nested data
;; shape (versions[N].state.X). Four stages:
;;
;;   personas × variants
;;     → reaction         (M replays per cell)
;;     → classification   (consumes reactions for one cell)
;;   variants
;;     → boundary         (consumes classifications across personas)
;;     → gap analysis     (consumes boundary)
;;
;; Wiring (config-as-code — config.scm ships per run):
;;   files:
;;     personas.json    nested-shape (V's .data/profiles-*.json)
;;     variants.json    list of { id, lead, scenario, hero-lines } objects
;;     config.scm       per-run config/<name> defines:
;;       config/product-context  string used in each prompt
;;       config/min-replays      reactions per cell (e.g. 3)
;;       config/min-for-boundary skip boundary if fewer personas (e.g. 3)
;;
;; The boundary/gap stages can return #f when the threshold isn't met
;; — this replaces the reactor's depsReady gating with a plain `if`.

(require "config.scm")

;; ── Data-shape accessors ─────────────────────────────────────────────
;;
;; `field` and `values-of` are built into the runtime preamble.

(define (state-of profile)
  (field (last (field profile "versions")) "state"))

(define (join-array arr sep)
  (if (or (null? arr) (not (pair? arr)))
    ""
    (apply string-append
      (map (lambda (s) (string-append s sep)) arr))))

(define (persona-line p)
  (let ((s (state-of p)))
    (string-append (field s "name") ": " (field s "oneLine"))))

(define (persona-summary p)
  (let ((s (state-of p)))
    (apply string-append
      (map (lambda (entry)
             (let ((label (car entry)) (k (car (cdr entry))))
               (let ((v (field s k)))
                 (if (or (null? v) (equal? v ""))
                   ""
                   (string-append label ": "
                     (if (pair? v) (join-array v "; ") v) "\n")))))
        (list (list "Name"       "name")
              (list "One-line"   "oneLine")
              (list "Occupation" "occupation")
              (list "Pains"      "pains")
              (list "Goals"      "goals")
              (list "Jobs-to-be-done" "jobsToBeDone")
              (list "Current tool stack" "currentToolStack")
              (list "Dealbreakers" "dealbreakers"))))))

;; ── Schemas ──────────────────────────────────────────────────────────

(define ClassificationSchema
  (s/object
    (s/field/number "acceptance"        "-1 strong reject, 0 ambivalent, 1 strong accept")
    (s/field/number "confidence"        "0 weak signal, 1 strong signal")
    (s/field/number "proximityToScope"  "-1 wrong category, 0 adjacent, 1 obvious target")
    (s/field/enum   "bucket"            (s/enum "A" "B" "C" "D"))
    (s/field/string "reasoning")))

(define AxisSchema
  (s/object
    (s/field/string "name")
    (s/field/string "description")
    (s/field/string "polarity")))

(define BoundarySchema
  (s/object
    (s/field/array   "axes" (s/array AxisSchema))
    (s/field/string  "boundaryDescription")
    (s/field/integer "inScopeCount")
    (s/field/integer "adjacentCount")
    (s/field/integer "outOfScopeCount")))

(define GapItemSchema
  (s/object
    (s/field/string  "region")
    (s/field/string  "rationale")
    (s/field/integer "targetPersonaCount")
    (s/field/number  "priority")))

(define GapSchema (s/object (s/field/array "gaps" (s/array GapItemSchema))))

;; ── Config ───────────────────────────────────────────────────────────

(define (product-header)
  (if (equal? config/product-context "") ""
      (string-append "Product context:\n" config/product-context "\n\n")))

;; ── Stage 1: reaction (N replays per cell) ───────────────────────────

(define (react-user persona variant)
  (string-append (product-header)
    "You are a synthetic respondent. React in the voice of the person below.\n\n"
    "PERSONA:\n" (persona-summary persona) "\n---\n"
    (field variant "scenario") "\n"
    (field variant "lead") "\n\n"
    "Answer in three short parts, labelled (a) (b) (c):\n"
    "(a) What does this tell you about the product?\n"
    "(b) Would you keep reading, click, or bounce? Pick one and say why.\n"
    "(c) First concern, suspicion, or question?"))

(define (react-cell persona variant replay-idx)
  (car (infer/chat "fast"
         (list (infer/chat/system "Stay in persona. No preamble. Be terse.")
               (infer/chat/user   (react-user persona variant)))
         #f
         (string-append (field variant "id") "/" (field persona "id") "/" (number->string replay-idx)))))

(define (cell-reactions persona variant)
  (map (lambda (i) (react-cell persona variant i)) (range config/min-replays)))

;; ── Stage 2: classification (consumes M reactions) ───────────────────

(define (classify-user persona variant reactions)
  (string-append (product-header)
    "Classify how this persona responded to this hero variant.\n\n"
    "PERSONA:\n" (persona-line persona) "\n\n"
    "HERO VARIANT (id=" (field variant "id") "):\n" (field variant "lead") "\n\n"
    "REACTIONS (" (number->string (length reactions)) " replays):\n"
    (apply string-append
      (map (lambda (i r) (string-append "Replay " (number->string (+ i 1)) ": " r "\n\n"))
           (range (length reactions)) reactions))
    "Each axis in [-1,1]: acceptance, confidence, proximityToScope. "
    "Bucket: A in-scope · B hesitating · C adjacent · D out-of-scope."))

(define (cell-classify persona variant)
  (let ((reactions (cell-reactions persona variant)))
    (car (infer/chat "fast"
           (list (infer/chat/system "Return only JSON.")
                 (infer/chat/user   (classify-user persona variant reactions)))
           ClassificationSchema
           (string-append (field variant "id") "/" (field persona "id"))))))

;; ── Stage 3: boundary (consumes all classifications for a variant) ───
;;
;; Gating: skip if fewer than MIN-FOR-BOUNDARY personas. This replaces
;; the reactor's depsReady mechanism with a plain conditional.

(define (boundary-user variant cls)
  (string-append (product-header)
    "Map the audience boundary from classified reactions.\n\n"
    "Hero variant (id=" (field variant "id") "):\n" (field variant "lead") "\n\n"
    "Classified personas (" (number->string (length cls)) "):\n"
    (apply string-append
      (map (lambda (entry)
             (string-append (field (state-of (car entry)) "name")
                            " → " (field (car (cdr entry)) "bucket") "\n"))
           cls))
    "\nIdentify 3-5 structural axes separating in-scope (A/B/C) from out-of-scope (D), "
    "and the boundary in one or two sentences."))

(define (variant-boundary variant personas)
  (let ((cls (map (lambda (p) (list p (cell-classify p variant))) personas)))
    (if (< (length cls) config/min-for-boundary)
      #f
      (car (infer/chat "high"
             (list (infer/chat/system "Return only JSON.")
                   (infer/chat/user   (boundary-user variant cls)))
             BoundarySchema
             (string-append (field variant "id") "/boundary"))))))

;; ── Stage 4: gap analysis ────────────────────────────────────────────

(define (gap-user variant boundary)
  (string-append (product-header)
    "Analyse gaps in audience coverage for boundary clarity.\n\n"
    "Variant " (field variant "id") " boundary: "
    (field boundary "boundaryDescription") "\n\n"
    "Identify 2-4 largest under-sampled regions near the A↔B and B↔C transitions. "
    "For each: region, rationale, target persona count (3-8), priority 0..1."))

(define (variant-gap variant personas)
  (let ((boundary (variant-boundary variant personas)))
    (if (equal? boundary #f)
      #f
      (car (infer/chat "high"
             (list (infer/chat/system "Return only JSON.")
                   (infer/chat/user   (gap-user variant boundary)))
             GapSchema
             (string-append (field variant "id") "/gap"))))))

;; ── Pipeline ─────────────────────────────────────────────────────────

(require "personas.json")
(require "variants.json")

(define persona-list (values-of personas))

(map (lambda (v)
       (list (field v "id")
             (variant-boundary v persona-list)
             (variant-gap      v persona-list)))
     variants)
