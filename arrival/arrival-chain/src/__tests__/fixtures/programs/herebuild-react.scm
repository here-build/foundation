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
;;     personas.yaml                       baseline personas in V's nested-shape
;;     summary-of-persona.hbs              per-persona prompt fragment
;;     reaction-prompt-of-persona.hbs      full reaction user-prompt
;;     config.scm                          per-run config/<name> defines:
;;       config/hero-id        identifier for the variant (e.g. "V9")
;;       config/hero-lead      the hero text being tested
;;       config/replays        per-persona replay count (e.g. 10)
;;       config/system-prompt  reaction system prompt

;; `(:key obj)` keyword accessors and `values-of` are built into the runtime preamble.

(require "config.scm")
(require "_util.scm")   ;; string-concat

;; ── Reaction prompt (shared with herebuild-multi) ────────────────────
;;
;; reaction.prompt carries the tier + output schema (Picoschema) + the
;; system/user body — so ReactionSchema and the (system)(user) ceremony are
;; gone from here. The system prompt is config-driven ({{systemPrompt}}); the
;; hero text flows in as {{lead}}. summary-of-persona.hbs stays a text fragment.
;; `config/<key>` IS the config value — an ordinary binding spilled by require.

(define summary-of-persona (require "summary-of-persona.hbs"))   ;; text fragment
(define react              (require "reaction.prompt"))

(define state-of (compose :state last :versions))

;; ── One reaction cell ────────────────────────────────────────────────
;;
;; cache-key combines hero-id + persona id + replay index so changing
;; any of those produces a distinct task.

(define (reaction-of-persona-replay persona replay-idx)
  (react
    (string-concat "/" config/hero-id (:id persona) replay-idx)
    :systemPrompt  config/system-prompt
    :summary       (summary-of-persona (state-of persona))
    :lead          config/hero-lead))

(define (row-of-persona persona)
  (list (:id persona)
        (map (cut reaction-of-persona-replay persona <>) (range config/replays))))

;; ── Pipeline ─────────────────────────────────────────────────────────

(define personas (require "personas.yaml"))
(map row-of-persona (values-of personas))
