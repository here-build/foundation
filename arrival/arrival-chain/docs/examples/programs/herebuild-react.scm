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
;; Wiring (via scripts/arrival-chain/configs/herebuild-react.example.json):
;;   files:
;;     personas.json                       baseline personas in V's nested-shape
;;     summary-of-persona.hbs              per-persona prompt fragment
;;     reaction-prompt-of-persona.hbs      full reaction user-prompt
;;   env:
;;     hero-id        identifier for the variant (e.g. "V9")
;;     hero-lead      the hero text being tested
;;     replays        per-persona replay count (e.g. 10)
;;     system-prompt  reaction system prompt

;; `field` and `values-of` are built into the runtime preamble.

;; ── Schema ───────────────────────────────────────────────────────────

(define ReactionSchema
  (s/object
    (s/field/string "interpretation" "what (a) said: what the product does and what it trades")
    (s/field/string "verdict"        "what (b) said: keep-reading | click | bounce + reason")
    (s/field/string "concern"        "what (c) said: first concern or question")))

;; ── Project environment ──────────────────────────────────────────────
;;
;; `project/<key>` IS the env value at that key — a noun, not a fetch.
;; The fallback resolver (registered on the scheme env at run time) turns
;; the bare symbol into the lookup. No quoted-string indirection;
;; renaming an env key shows up as a moved symbol, not a moved literal.

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
         (list (infer/chat/system project/system-prompt)
               (infer/chat/user
                 (reaction-prompt-of-persona
                   "summary" (summary-of-persona (state-of persona))
                   "lead"    project/hero-lead)))
         ReactionSchema
         (string-append project/hero-id "/" (field persona "id") "/" (number->string replay-idx)))))

(define (row-of-persona persona)
  (list (field persona "id")
        (map (lambda (i) (reaction-of-persona-replay persona i)) (range project/replays))))

;; ── Pipeline ─────────────────────────────────────────────────────────

(require "personas.json")
(map row-of-persona (values-of personas))
