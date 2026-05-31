;; Find the best tagline for a persona pool.
;;
;; GEPA-style hill climb with hierarchical audience-split on plateau:
;;
;;   1. Inner loop — propose tagline → fan out reactions → reflect → repeat.
;;      Stops when a 3-frame rolling window stops improving (or degrades).
;;   2. On plateau, if bounce-rate exceeds `bounce-threshold`, triage the
;;      bouncers into AUDIENCE MISMATCH (category-level rejection) vs
;;      LATENT FIT (could be reached with different wording).
;;   3. Recurse on the latent-fit subset; the child loop inherits the parent's
;;      reach-frontier as hints — the reflection LM sees which prior taglines
;;      reached which personas and synthesises accordingly.
;;
;; The recursion is tail-recursive in a worklist fold; `total-iter-cap` is
;; the safety net against oscillation inside the plateau ε band.
;;
;; Wiring (config-as-code — config.scm ships per run):
;;   files:
;;     personas.yaml                  baseline personas
;;     summary-of-persona.hbs         per-persona prompt fragment
;;     tagline-reaction.hbs           per-(persona, tagline) reaction
;;     reflection-prompt.hbs          propose next tagline from current + hints
;;     triage-prompt.hbs              mismatch vs latent fit, default-biased
;;   config.scm (per-run experimental knobs only — system prompts live in
;;        this program as constants since they define the algorithm, not
;;        the experiment):
;;     config/initial-tagline    the starting candidate
;;     config/max-iter           inner GEPA loop cap per branch (e.g. 8)
;;     config/plateau-delta      degrading threshold, typically 0.02 (i.e. need ≥2%)
;;     config/total-iter-cap     worklist branch cap (oscillation safety, e.g. 20)
;;     config/bounce-threshold   bounce-rate above which we triage and split (e.g. 0.50)
;;     config/pov-count          how many of the typed reflection POVs to run per branch (1..4)

(require "config.scm")
(require "_util.scm")   ;; string-concat + suite helpers

;; ── System prompts now live in the .prompt files ────────────────────
;;
;; reaction / triage / merge / consolidation each carry their (constant) system
;; prompt in their .prompt {{role "system"}} section. Reflection's system is
;; PER-POV, so reflection.prompt takes it as {{sys}} — and the POV systems are
;; per-run experiment DATA, so they live in povs.yaml (below), not inline here
;; and not in a .prompt (they're neither a fixed algorithm role nor code).

;; ── helpers ──────────────────────────────────────────────────────────
;; entry = (tagline score reactions). cadr/caddr live in BUILTIN_PREAMBLE.
(define (entry-score e) (cadr e))
(define (entry-reactions e) (caddr e))
(define (avg xs) (if (null? xs) 0 (/ (apply + xs) (length xs))))

(define (clicking? v) (or (equal? v "click") (equal? v "keep-reading")))
(define (bouncing? v) (equal? v "bounce"))

(define (state-of persona)
  (:state (last (:versions persona))))

;; ── prompts (.prompt = full inference unit) + the one text fragment ──
;;
;; Each .prompt carries its tier + output schema (Picoschema) + system/user
;; body, so the four s/object schemas and four system constants that used to
;; sit here are gone. Each binding is a callable: (reflect cache-key "k" v …)
;; runs the inference and returns the parsed result. summary-of-persona stays
;; a text fragment, rendered into the user turns.
(define summary-of-persona (require "summary-of-persona.hbs"))   ;; text fragment
(define react-to-tagline   (require "tagline-reaction.prompt"))
(define reflect            (require "reflection.prompt"))
(define triage             (require "triage.prompt"))
(define merge-tagline      (require "merge.prompt"))
(define consolidate        (require "consolidation.prompt"))

;; ── reactions ────────────────────────────────────────────────────────
(define (reaction-of-persona-tagline persona tagline)
  (react-to-tagline
    (string-concat "/" tagline (:id persona))
    "summary" (summary-of-persona (state-of persona))
    "tagline" tagline))

(define (reactions-of tagline personas)
  (map (lambda (p) (reaction-of-persona-tagline p tagline)) personas))

(define (click-rate reactions)
  (let ((n (length reactions)))
    (if (= n 0) 0
        (/ (count-if (lambda (r) (clicking? (:verdict r))) reactions) n))))

;; ── plateau detection: 3-frame rolling window ───────────────────────
;; Compare avg of latest 3 entries against avg of the 3 before that.
;; Stop when delta < plateau-delta (flat OR degrading).
(define (degrading? history delta)
  (cond ((< (length history) 6) #f)
        (else
         (< (- (avg (map entry-score (take 3 history)))
               (avg (map entry-score (take 3 (drop 3 history)))))
            delta))))

;; ── frontier: per-tagline reach map ─────────────────────────────────
;; For each tagline in history, the persona-ids it reached. Inherited
;; hints (from a parent worklist task) are unioned in.
(define (clickers-of personas reactions)
  (reduce (lambda (pr acc)
            (if (clicking? (:verdict (cadr pr)))
                (cons (:id (car pr)) acc) acc))
          '() (map list personas reactions)))

(define (frontier-of history personas inherited)
  (append inherited
    (map (lambda (e) (list (car e) (clickers-of personas (entry-reactions e))))
         history)))

(define (hints-signature hints)
  (string-concat ";"
    (map (lambda (h) (string-append (car h) ":" (join "," (cadr h))))
         hints)))

;; ── reflection ───────────────────────────────────────────────────────
(define (reactions-summary reactions personas)
  (map (lambda (p r) (dict "persona" (:id p)
                           "verdict" (:verdict r)
                           "concern" (:concern r)))
       personas reactions))

(define (hints-summary hints)
  (map (lambda (h) (dict "tagline" (car h) "reached" (join ", " (cadr h))))
       hints))

(define (next-tagline current reactions personas hints sys)
  (:next (reflect
      (string-concat "/" "reflect" sys current (hints-signature hints))
      "sys"       sys
      "current"   current
      "reactions" (reactions-summary reactions personas)
      "hints"     (hints-summary hints))))

;; ── inner GEPA loop ──────────────────────────────────────────────────
(define (best-of history) (max-by entry-score history))

;; reflection-system passed in so multi-POV can run K loops in parallel
;; with different reflection prompts on the same (initial, personas, hints).
(define (gepa-until-plateau initial personas hints sys)
  (define (loop tagline iter history)
    (let* ((reactions (reactions-of tagline personas))
           (score     (click-rate reactions))
           (entry     (list tagline score reactions))
           (history+  (cons entry history))
           (fr        (frontier-of history+ personas hints)))
      (cond
        ((>= iter config/max-iter)                  (best-of history+))
        ((degrading? history+ config/plateau-delta) (best-of history+))
        (else (loop (next-tagline tagline reactions personas fr sys) (+ iter 1) history+)))))
  (loop initial 0 '()))

;; ── multi-POV ───────────────────────────────────────────────────────
;;
;; Run K plateau loops in parallel with K typed reflection system
;; prompts (Brand Guardian / Growth Hacker / Product Manager / Whimsy).
;; The substrate parallelises naturally — each inner reaction-call is a
;; separate task, the K loops share nothing but the read-only inputs.
;; After all plateau, the run with the highest final score wins; ties
;; broken by POV order (Brand Guardian first when scores tie).
;;
;; Cheap diversity injection where GEPA gets it from a population
;; frontier. Each POV explores a different region of tagline-space; the
;; winner reflects which framing landed best for *this* persona pool,
;; useful signal beyond just the final tagline.
;; The POVs are per-run experiment DATA (a list of { name, system }), not a
;; fixed algorithm role — so they live in povs.yaml, edited without touching
;; this file, like personas.yaml. (require) spills `povs`.
(define povs (require "povs.yaml"))

;; pov-count selects how many POVs to actually run (1..K). Test rigs
;; pin it to 1 to keep call counts predictable; live runs use all K.
(define (active-povs)
  (take config/pov-count povs))

(define (multi-pov-run initial personas hints)
  (let ((runs (map (lambda (pov)
                     (let ((entry (gepa-until-plateau initial personas hints (:system pov))))
                       (dict "pov" (:name pov) "entry" entry)))
                   (active-povs))))
    (max-by (lambda (r) (cadr (:entry r))) runs)))

;; ── triage ───────────────────────────────────────────────────────────
(define (triage-one persona reaction tagline)
  (let ((v (triage
             (string-concat "/" "triage" tagline (:id persona))
             "summary" (summary-of-persona (state-of persona))
             "tagline" tagline
             "verdict" (:verdict reaction)
             "concern" (:concern reaction))))
    (dict "persona"  persona
          "reaction" reaction
          "mismatch" (:mismatch v)
          "reason"   (:reason v))))

(define (triage-bouncers personas reactions tagline)
  (reduce (lambda (pr acc)
            (let ((p (car pr)) (r (cadr pr)))
              (if (bouncing? (:verdict r))
                  (cons (triage-one p r tagline) acc) acc)))
          '() (map list personas reactions)))

;; ── worklist driver ──────────────────────────────────────────────────
;; Split into three phases: score (run inner loop + triage), build node
;; record, and (only if recursing) construct the child task. drive then
;; reads as: score → build → route.
(define (score-task task)
  (let* ((personas    (:personas task))
         (initial     (:initial task))
         (hints       (:hints task))
         (run         (multi-pov-run initial personas hints))
         (winning-pov (:pov run))
         (best-entry  (:entry run))
         (best-tag    (car best-entry))
         (reactions   (caddr best-entry))
         (br          (- 1 (cadr best-entry)))
         (triaged     (if (>= br config/bounce-threshold)
                          (triage-bouncers personas reactions best-tag)
                          '()))
         (unsatisfied (filter (lambda (t) (equal? (:mismatch t) #f)) triaged)))
    (list best-entry br triaged unsatisfied winning-pov)))

(define (make-node node-id task best-entry br triaged winning-pov)
  (dict "id"          node-id
        "parent-id"   (:parent-id task)
        "tagline"     (car best-entry)
        "personas"    (map (lambda (p) (:id p)) (:personas task))
        "reactions"   (caddr best-entry)
        "bounce-rate" br
        "triaged"     triaged
        "pov"         winning-pov))

(define (child-task-of parent-task parent-best-entry parent-node-id unsatisfied)
  (let ((personas (:personas parent-task))
        (hints    (:hints parent-task)))
    (dict "personas"  (map (lambda (t) (:persona t)) unsatisfied)
          "initial"   (car parent-best-entry)
          "parent-id" parent-node-id
          "hints"     (frontier-of (list parent-best-entry) personas hints))))

(define (optimize-tagline initial-tagline initial-personas)
  (define (drive worklist results total-iter)
    (cond
      ((null? worklist) (reverse results))
      ((>= total-iter config/total-iter-cap) (reverse results))
      (else
       (let ((task (car worklist)) (rest (cdr worklist)))
         (apply
           (lambda (best-entry br triaged unsatisfied winning-pov)
             (let* ((node-id (length results))
                    (node    (make-node node-id task best-entry br triaged winning-pov)))
               (cond
                 ((or (< br config/bounce-threshold) (null? unsatisfied))
                  (drive rest (cons node results) (+ total-iter 1)))
                 (else
                  (drive (cons (child-task-of task best-entry node-id unsatisfied) rest)
                         (cons node results)
                         (+ total-iter 1))))))
           (score-task task))))))
  (drive (list (dict "personas" initial-personas
                     "initial" initial-tagline
                     "parent-id" -1
                     "hints" '()))
         '() 0))

;; ── format variants ─────────────────────────────────────────────────
;;
;; After the worklist produces 2+ branches, try assembling the
;; root-branch and last-branch winners into a single compound message.
;; Three formats run as independent plateau loops on the FULL pool:
;;
;;   concat      "A. B."                       (naive juxtaposition)
;;   two-screen  "A. On second screen: B."     (title + secondary)
;;   merge       <single tagline merging A+B>  (one-shot LM merge → plateau)
;;
;; Best click-rate wins. Returns #f when there are fewer than 2 branches.
;; Each compound run reuses multi-pov-run, so multi-POV diversity layers
;; on for free.
(define (merge-initial a b)
  (:next (merge-tagline (string-append "merge-init/" a "|" b) "a" a "b" b)))

(define (compound-of-results results all-personas)
  (cond
    ((< (length results) 2) #f)
    (else
     (let* ((root      (car results))
            (lastnode  (car (reverse results)))
            (a         (:tagline root))
            (b         (:tagline lastnode))
            (forms (list
                     (dict "format" "concat"
                           "initial" (string-append a ". " b "."))
                     (dict "format" "two-screen"
                           "initial" (string-append a ". On second screen: " b "."))
                     (dict "format" "merge"
                           "initial" (merge-initial a b))))
            (runs (map (lambda (f)
                         (let ((run (multi-pov-run (:initial f) all-personas '())))
                           (dict "format"  (:format f)
                                 "sources" (list a b)
                                 "pov"     (:pov run)
                                 "entry"   (:entry run))))
                       forms))
            (winner (max-by (lambda (r) (cadr (:entry r))) runs)))
       (dict "format"    (:format winner)
             "tagline"   (car (:entry winner))
             "score"     (cadr (:entry winner))
             "reactions" (caddr (:entry winner))
             "pov"       (:pov winner)
             "sources"   (:sources winner))))))

;; ── bucketize: per-persona final classification ─────────────────────
;;
;; Walks the flat results list once per persona. The triaged entries
;; carry the full persona object (so child branches can re-run on the
;; object); node.personas carries IDs only. Both surface this persona
;; via its id, so the comparison key is always the id string.
;;
;; Precedence on conflict: clicking > audience-miss > unreachable.
;; If a persona was triaged mismatch=true in one branch but later clicked
;; in a child branch, treat them as clicking — the click is positive
;; evidence that overrides an earlier categorical-rejection guess.
(define (reaction-of-persona-in-node pid node)
  (let loop ((ps (:personas node)) (rs (:reactions node)))
    (cond ((null? ps) #f)
          ((equal? (car ps) pid) (car rs))
          (else (loop (cdr ps) (cdr rs))))))

(define (triage-of-persona-in-node pid node)
  (let loop ((ts (:triaged node)))
    (cond ((null? ts) #f)
          ((equal? (:id (:persona (car ts))) pid) (car ts))
          (else (loop (cdr ts))))))

(define (persona-result pid results)
  (let walk ((rs results) (click #f) (mismatch #f) (last-bounce #f))
    (cond
      ((null? rs)
       (cond (click           (dict "bucket" "clicking"
                                    "tagline" (car click)
                                    "reaction" (cadr click)))
             (mismatch        (dict "bucket" "audience-miss" "reason" mismatch))
             (else            (dict "bucket" "unreachable"
                                    "reason" (if last-bounce last-bounce "no data")))))
      (else
       (let* ((node     (car rs))
              (reaction (reaction-of-persona-in-node pid node))
              (triage   (triage-of-persona-in-node pid node))
              (click+
                (if (and reaction (clicking? (:verdict reaction)))
                    (list (:tagline node) reaction)
                    click))
              (mismatch+
                (if (and triage (equal? (:mismatch triage) #t))
                    (:reason triage)
                    mismatch))
              (last-bounce+
                (if (and reaction (bouncing? (:verdict reaction)))
                    (:concern reaction)
                    last-bounce)))
         (walk (cdr rs) click+ mismatch+ last-bounce+))))))

(define (bucketize results personas)
  (map (lambda (p)
         (let* ((pid (:id p))
                (res (persona-result pid results)))
           (dict "id"       pid
                 "bucket"   (:bucket res)
                 "tagline"  (:tagline res)
                 "reason"   (:reason res)
                 "reaction" (:reaction res))))
       personas))

;; ── consolidation: distil bucket reasons into a structured summary ──
(define (reasons-for-template entries)
  (map (lambda (e) (dict "persona" (:id e) "reason" (:reason e)))
       entries))

(define (consolidate-reasons label entries)
  (cond
    ((null? entries) (dict "summary" "" "key-points" '()))
    (else
     (consolidate
       (string-concat "/" "consolidate" label
         (string-concat "" (map (lambda (e) (:id e)) entries)))
       "label"   label
       "reasons" (reasons-for-template entries)))))

;; ── entry ────────────────────────────────────────────────────────────
(define personas (require "personas.yaml"))

(define initial-personas (values-of personas))
(define results          (optimize-tagline config/initial-tagline initial-personas))
(define compound         (compound-of-results results initial-personas))
(define buckets          (bucketize results initial-personas))

(define audience-miss-entries
  (filter (lambda (b) (equal? (:bucket b) "audience-miss")) buckets))
(define unreachable-entries
  (filter (lambda (b) (equal? (:bucket b) "unreachable")) buckets))

(dict
  "tree"     results
  "compound" compound
  "buckets"  buckets
  "summaries" (dict
                "audience-miss" (consolidate-reasons
                                  "not being in our target audience"
                                  audience-miss-entries)
                "unreachable"   (consolidate-reasons
                                  "bouncing on every tagline we tried"
                                  unreachable-entries)))
