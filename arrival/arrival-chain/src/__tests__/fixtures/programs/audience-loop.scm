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
;;     personas.yaml    nested-shape (V's .data/profiles-*.json)
;;     variants.yaml    list of { id, lead, scenario, hero-lines } objects
;;     config.scm       per-run config/<name> defines:
;;       config/product-context  string used in each prompt
;;       config/min-replays      reactions per cell (e.g. 3)
;;       config/min-for-boundary skip boundary if fewer personas (e.g. 3)
;;
;; Each stage is a .prompt (dotprompt): tier (model:) + output schema
;; (Picoschema) + system/user body in one file. This .scm keeps only the
;; data-shaping and the fan-out; the schemas and tiers live in .prompt
;; frontmatter. summary-of-persona.hbs stays a text fragment, shared with
;; herebuild-react/-multi.
;;
;; The boundary/gap stages can return #f when the threshold isn't met
;; — this replaces the reactor's depsReady gating with a plain `if`.

(require "config.scm")
(require "_util.scm")   ;; string-concat + suite helpers

;; ── Data-shape accessors ─────────────────────────────────────────────
;;
;; `(:key obj)` keyword accessors and `values-of` are built into the runtime
;; preamble — `(:name s)` reads the "name" field of the JS object s.

(define state-of (compose :state last :versions))

(define (persona-line p)
  (let ((s (state-of p)))
    (string-append (:name s) ": " (:oneLine s))))

;; ── Prompts (.prompt = a full inference unit) ────────────────────────
;;
;; Each .prompt carries its tier (model:), output schema (Picoschema), and
;; system/user body. Requiring one yields a callable that RUNS the inference —
;; `(classify cache-key "key" value …)` returns the parsed result directly.
;; So the five s/object schema blocks and the tier + system literals that used
;; to live here are gone; they're in the .prompt frontmatter. The cache-key is
;; the first argument (it's the dedup/provenance identity, often a computed loop
;; key, which the inputs alone don't determine).
(define summary-of-persona (require "summary-of-persona.hbs"))   ;; text fragment
(define react        (require "react.prompt"))    ;; free text — no output schema
(define classify     (require "classify.prompt"))
(define map-boundary (require "boundary.prompt"))
(define find-gaps    (require "gap.prompt"))

;; ── Config-derived prompt fragment ───────────────────────────────────

(define (product-header)
  (if (equal? config/product-context "") ""
      (string-append "Product context:\n" config/product-context "\n\n")))

;; ── Stage 1: reaction (N replays per cell) ───────────────────────────

(define (react-cell persona variant replay-idx)
  (react
    (string-concat "/" (:id variant) (:id persona) replay-idx)
    :productHeader  (product-header)
    :summary        (summary-of-persona (state-of persona))
    :scenario       (:scenario variant)
    :lead           (:lead variant)))

(define (cell-reactions persona variant)
  (map (cut react-cell persona variant <>) (range config/min-replays)))

;; ── Stage 2: classification (consumes M reactions) ───────────────────

(define (reactions-block reactions)
  (string-concat "\n\n"
    (map (lambda (i r) (string-append "Replay " (+ i 1) ": " r))
         (range (length reactions)) reactions)))

(define (cell-classify persona variant)
  (let ((reactions (cell-reactions persona variant)))
    (classify
      (string-concat "/" (:id variant) (:id persona))
      :productHeader   (product-header)
      :personaLine     (persona-line persona)
      :variantId       (:id variant)
      :lead            (:lead variant)
      :replayCount     (length reactions)
      :reactionsBlock  (reactions-block reactions))))

;; ── Stage 3: boundary (consumes all classifications for a variant) ───
;;
;; Gating: skip if fewer than MIN-FOR-BOUNDARY personas. This replaces
;; the reactor's depsReady mechanism with a plain conditional.

(define (cls-block cls)
  (string-concat "\n"
    (map (lambda (entry)
           (string-append (->> entry car state-of :name)
                          " → " (->> entry cadr :bucket)))
         cls)))

(define (variant-boundary variant personas)
  (let ((cls (map (lambda (p) (list p (cell-classify p variant))) personas)))
    (if (< (length cls) config/min-for-boundary)
      #f
      (map-boundary
        (string-concat "/" (:id variant) "boundary")
        :productHeader  (product-header)
        :variantId      (:id variant)
        :lead           (:lead variant)
        :clsCount       (length cls)
        :clsBlock       (cls-block cls)))))

;; ── Stage 4: gap analysis ────────────────────────────────────────────

(define (variant-gap variant personas)
  (let ((boundary (variant-boundary variant personas)))
    (if (equal? boundary #f)
      #f
      (find-gaps
        (string-concat "/" (:id variant) "gap")
        :productHeader        (product-header)
        :variantId            (:id variant)
        :boundaryDescription  (:boundaryDescription boundary)))))

;; ── Pipeline ─────────────────────────────────────────────────────────

(define personas (require "personas.yaml"))
(define variants (require "variants.yaml"))

(define persona-list (values-of personas))

(map (lambda (v)
       (list (:id v)
             (variant-boundary v persona-list)
             (variant-gap      v persona-list)))
     variants)
