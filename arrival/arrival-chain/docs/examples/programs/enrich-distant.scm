;; Runnable port of scripts/enrich-distant-personas.ts onto the
;; arrival-chain substrate. Reads baseline + OWL seeds from JSON files
;; in their native nested shape (versions[N].state.X), enriches each
;; seed against the accumulating set of baseline + already-enriched.
;;
;; Wiring (via scripts/arrival-chain/configs/enrich-distant.json):
;;   baseline.json    .data/profiles-prj_…json
;;   owl-seeds.json   .data/profiles-owl-extras-…json
;;   env:
;;     product-context  the prose used in the system prompt
;;
;; The output is a list of enriched persona objects.

;; ── Data-shape access ────────────────────────────────────────────────
;;
;; Each entry in baseline/owl-seeds is a profile record:
;;   { id, projectId, versions: [ { n, state: { name, oneLine, ... } } ] }
;; We always want the LATEST version's state.

(define (last lst)
  (if (null? (cdr lst))
    (car lst)
    (last (cdr lst))))

;; Universal field accessor — alists (from JSON require) AND js-objects
;; (from infer results). Flattened cond layout: walk an alist via car/
;; cdr; for any other shape (JS object), fall through to `@`.
(define (state-of profile)
  (field (last (field profile "versions")) "state"))

;; The require'd JSON is a JS object map { profileId → profileRecord }.
;; `values-of` is built into the runtime — returns the value list.

;; Render a profile as a one-line summary (for the prompt).
(define (summary-line p)
  (let ((s (state-of p)))
    (string-append (field s "name") ": " (field s "oneLine"))))

;; ── Schemas ──────────────────────────────────────────────────────────

(define EnrichedSchema
  (s/object
    (s/field/string "id")
    (s/field/string "name")
    (s/field/string "oneLine"           "concrete one-liner with brand anchors")
    (s/field/string "occupation")
    (s/field/array  "pains"             (s/array "string"))
    (s/field/array  "goals"             (s/array "string"))
    (s/field/array  "jobsToBeDone"      (s/array "string"))
    (s/field/array  "currentToolStack"  (s/array "string"))
    (s/field/array  "dealbreakers"      (s/array "string"))))

;; ── System prompt ────────────────────────────────────────────────────
;;
;; Required for the call. Lives in env so it can be tuned without
;; editing the .scm.

(define enrich-system (project/get "system-prompt"))

;; ── The enrichment ───────────────────────────────────────────────────

(define (render-avoid avoid-list)
  (apply string-append
    (map (lambda (p) (string-append "- " (summary-line p) "\n")) avoid-list)))

(define (enrich-against avoid seed)
  (let ((seed-state (state-of seed)))
    (car (infer/chat "high"
           (list (infer/chat/system enrich-system)
                 (infer/chat/user
                   (string-append
                     "Baseline personas to stand APART from:\n"
                     (render-avoid avoid) "\n"
                     "ABSTRACT SKETCH (push toward most distant plausible target user):\n"
                     "Name: "       (field seed-state "name")       "\n"
                     "One-line: "   (field seed-state "oneLine")    "\n"
                     "Occupation: " (field seed-state "occupation") "\n\n"
                     "Return the JSON object.")))
           EnrichedSchema
           (field seed "id")))))

(define (enrich-all/accumulating seeds baseline)
  (define (loop remaining acc)
    (if (null? remaining)
      (reverse acc)
      (let ((next (enrich-against (append baseline (reverse acc)) (car remaining))))
        (loop (cdr remaining) (cons next acc)))))
  (loop seeds '()))

;; ── Pipeline ─────────────────────────────────────────────────────────

(require "baseline.json")    ;; → baseline (object map)
(require "owl-seeds.json")   ;; → owl-seeds (object map)

(enrich-all/accumulating (values-of owl-seeds) (values-of baseline))
