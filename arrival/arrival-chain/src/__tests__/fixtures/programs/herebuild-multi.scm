;; Multi-variant version of herebuild-react. K variants × N personas ×
;; M replays — pure-parallel reactions. Used when you want to compare
;; hero-text variants against the same persona pool in a single run.
;;
;; Wiring (config-as-code — config.scm ships per run):
;;   files:
;;     personas.yaml    nested-shape persona file
;;     variants.yaml    list of { id, lead, scenario } entries
;;     config.scm       per-run config/<name> defines:
;;       config/replays          per-cell replay count
;;       config/system-prompt    reaction system prompt
;;
;; Output: a list of (variant-id . reactions-by-persona) entries, where
;; reactions-by-persona is itself a list of (persona-id reaction*).

(require "config.scm")
(require "_util.scm")   ;; string-concat

(define state-of (compose :state last :versions))

;; ── Shared reaction prompt (with herebuild-react) ────────────────────
;;
;; herebuild-multi IS herebuild-react with one extra axis: same persona summary,
;; same reaction.prompt, the lead now coming from each variant instead of a
;; single config/hero-lead. Requiring the same .prompt makes that sameness
;; literal — and the output schema + tier now live in the prompt, not here.

(define summary-of-persona (require "summary-of-persona.hbs"))   ;; text fragment
(define react              (require "reaction.prompt"))

(define (react-cell persona variant replay-idx)
  (react
    (string-concat "/" (:id variant) (:id persona) replay-idx)
    :systemPrompt  config/system-prompt
    :summary       (summary-of-persona (state-of persona))
    :lead          (:lead variant)))

(define (cell-row persona variant)
  (list (:id persona)
        (map (cut react-cell persona variant <>) (range config/replays))))

(define (variant-row variant personas)
  (list (:id variant)
        (map (cut cell-row <> variant) personas)))

(define personas (require "personas.yaml"))
(define variants (require "variants.yaml"))

(map (cut variant-row <> (values-of personas)) variants)
