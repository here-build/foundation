;; Runnable port of scripts/herebuild-v9.ts (and the v5/v6/v7/v11 family).
;;
;; Cross-product: N personas × M replays of a single hero variant.
;; Pure parallel — each (persona, replay) cell is independent; the
;; substrate parallelises all N×M calls.
;;
;; Each binding NAMES what the expression IS — a noun-of-nouns describer,
;; not a verb. `(summary-of-persona p)` IS the summary text of persona p;
;; `(reaction-of-persona-replay p i)` IS the reaction recorded for that
;; (persona, replay) cell. Reading the program is staring at expressions
;; until each identity relation resolves — there is no interpreter
;; behaviour to mentally simulate.
;;
;; Wiring (config-as-code — config.scm ships per run):
;;   files:
;;     personas.json                       baseline personas in V's nested-shape
;;     summary-of-persona.hbs              per-persona prompt fragment
;;     reaction-prompt-of-persona.hbs      full reaction user-prompt
;;     config.scm                          per-run config/<name> defines:
;;       config/hero-id        identifier for the variant (e.g. "V9")
;;       config/hero-lead      the hero text being tested
;;       config/replays        per-persona replay count (e.g. 10)
;;       config/system-prompt  reaction system prompt

;; `field` and `values-of` are built into the runtime preamble.

(require "config.scm")

;; ── Schema ───────────────────────────────────────────────────────────

(define ReactionSchema
  (s/object
    (s/field/string "interpretation" "what (a) said: what the product does and what it trades")
    (s/field/string "verdict"        "what (b) said: keep-reading | click | bounce + reason")
    (s/field/string "concern"        "what (c) said: first concern or question")))

;; ── Config ───────────────────────────────────────────────────────────
;;
;; `config/<key>` IS the config value at that key — an ordinary binding
;; spilled by `(require "config.scm")`. Renaming a config key shows up as
;; a moved symbol, not a moved literal.

;; ── Templates as inline-callable lambdas ─────────────────────────────

(define summary-of-persona         (require "summary-of-persona.hbs"))
(define reaction-prompt-of-persona (require "reaction-prompt-of-persona.hbs"))

(define (state-of persona)
  (field (last (field persona "versions")) "state"))

;; ── One reaction cell ────────────────────────────────────────────────
;;
;; cache-key combines hero-id + persona id + replay index so changing
;; any of those produces a distinct task.

(define (reaction-of-persona-replay persona replay-idx)
  (car (infer/chat "high"
         (list (infer/chat/system config/system-prompt)
               (infer/chat/user
                 (reaction-prompt-of-persona
                   "summary" (summary-of-persona (state-of persona))
                   "lead"    config/hero-lead)))
         ReactionSchema
         (string-append config/hero-id "/" (field persona "id") "/" (number->string replay-idx)))))

(define (row-of-persona persona)
  (list (field persona "id")
        (map (lambda (i) (reaction-of-persona-replay persona i)) (range config/replays))))

;; ── Pipeline ─────────────────────────────────────────────────────────

(define personas (require "personas.json"))
(map row-of-persona (values-of personas))
