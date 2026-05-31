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
;; entry: one round's tagline + its click-rate score + the reactions it drew
(define (make-entry tagline score reactions) (dict :tagline tagline :score score :reactions reactions))
(define (avg xs) (if (null? xs) 0 (/ (apply + xs) (length xs))))

(define (clicking? v) (or (equal? v "click") (equal? v "keep-reading")))
(define (bouncing? v) (equal? v "bounce"))

(define state-of (compose :state last :versions))

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
    :summary (summary-of-persona (state-of persona))
    :tagline tagline))

(define (reactions-of tagline personas)
  (map (cut reaction-of-persona-tagline <> tagline) personas))

(define (click-rate reactions)
  (let ((n (length reactions)))
    (if (= n 0) 0
        (/ (count-if (compose clicking? :verdict) reactions) n))))

;; ── plateau detection: 3-frame rolling window ───────────────────────
;; Compare avg of latest 3 entries against avg of the 3 before that.
;; Stop when delta < plateau-delta (flat OR degrading).
(define (degrading? history delta)
  (cond ((< (length history) 6) #f)
        (else
         (< (- (->> history (take 3) (map :score) avg)
               (->> history (drop 3) (take 3) (map :score) avg))
            delta))))

;; ── frontier: per-tagline reach map ─────────────────────────────────
;; For each tagline in history, the persona-ids it reached. Inherited
;; hints (from a parent worklist task) are unioned in.
(define (clickers-of personas reactions)
  (reduce (lambda (pr acc)
            (let ((persona (car pr)) (reaction (cadr pr)))
              (if (clicking? (:verdict reaction))
                  (cons (:id persona) acc) acc)))
          '() (map list personas reactions)))

;; a hint: a tagline + the persona-ids it reached
(define (make-hint tagline reached) (dict :tagline tagline :reached reached))

(define (frontier-of history personas inherited)
  (append inherited
    (map (lambda (e) (make-hint (:tagline e) (clickers-of personas (:reactions e))))
         history)))

(define (hints-signature hints)
  (string-concat ";"
    (map (lambda (h) (string-append (:tagline h) ":" (join "," (:reached h))))
         hints)))

;; ── reflection ───────────────────────────────────────────────────────
(define (reactions-summary reactions personas)
  (map (lambda (p r) (dict :persona (:id p)
                           :verdict (:verdict r)
                           :concern (:concern r)))
       personas reactions))

(define (hints-summary hints)
  (map (lambda (h) (dict :tagline (:tagline h) :reached (join ", " (:reached h))))
       hints))

(define (next-tagline current reactions personas hints sys)
  (:next (reflect
      (string-concat "/" "reflect" sys current (hints-signature hints))
      :sys       sys
      :current   current
      :reactions (reactions-summary reactions personas)
      :hints     (hints-summary hints))))

;; ── inner GEPA loop ──────────────────────────────────────────────────
(define (best-of history) (max-by :score history))

;; reflection-system passed in so multi-POV can run K loops in parallel
;; with different reflection prompts on the same (initial, personas, hints).
(define (gepa-until-plateau initial personas hints sys)
  (define (loop tagline iter history)
    (let* ((reactions (reactions-of tagline personas))
           (score     (click-rate reactions))
           (entry     (make-entry tagline score reactions))
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
                       (dict :pov (:name pov) :entry entry)))
                   (active-povs))))
    (max-by (compose :score :entry) runs)))

;; ── triage ───────────────────────────────────────────────────────────
(define (triage-one persona reaction tagline)
  (let ((v (triage
             (string-concat "/" "triage" tagline (:id persona))
             :summary (summary-of-persona (state-of persona))
             :tagline tagline
             :verdict (:verdict reaction)
             :concern (:concern reaction))))
    (dict :persona  persona
          :reaction reaction
          :mismatch (:mismatch v)
          :reason   (:reason v))))

(define (triage-bouncers personas reactions tagline)
  (reduce (lambda (pr acc)
            (let ((persona (car pr)) (reaction (cadr pr)))
              (if (bouncing? (:verdict reaction))
                  (cons (triage-one persona reaction tagline) acc) acc)))
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
         (best-tag    (:tagline best-entry))
         (reactions   (:reactions best-entry))
         (br          (- 1 (:score best-entry)))
         (triaged     (if (>= br config/bounce-threshold)
                          (triage-bouncers personas reactions best-tag)
                          '()))
         (unsatisfied (filter (lambda (t) (equal? (:mismatch t) #f)) triaged)))
    (list best-entry br triaged unsatisfied winning-pov)))

;; a worklist task: the persona pool + seed tagline + parent link + reach hints
(define (make-task personas initial parent-id hints)
  (dict :personas personas :initial initial :parent-id parent-id :hints hints))

(define (make-node node-id task best-entry br triaged winning-pov)
  (dict :id          node-id
        :parent-id   (:parent-id task)
        :tagline     (:tagline best-entry)
        :personas    (map :id (:personas task))
        :reactions   (:reactions best-entry)
        :bounce-rate br
        :triaged     triaged
        :pov         winning-pov))

(define (child-task-of parent-task parent-best-entry parent-node-id unsatisfied)
  (let ((personas (:personas parent-task))
        (hints    (:hints parent-task)))
    (make-task (map :persona unsatisfied)
               (:tagline parent-best-entry)
               parent-node-id
               (frontier-of (list parent-best-entry) personas hints))))

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
  (drive (list (make-task initial-personas initial-tagline -1 '()))
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
  (:next (merge-tagline (string-append "merge-init/" a "|" b) :a a :b b)))

;; a candidate compound shape + the tagline that seeds its plateau loop
(define (format-variant fmt initial)
  (dict :format fmt :initial initial))

(define (compound-of-results results all-personas)
  (cond
    ((< (length results) 2) #f)
    (else
     (let* ((root      (car results))
            (lastnode  (last results))
            (a         (:tagline root))
            (b         (:tagline lastnode))
            (forms (list
                     (format-variant "concat"     (string-append a ". " b "."))
                     (format-variant "two-screen" (string-append a ". On second screen: " b "."))
                     (format-variant "merge"      (merge-initial a b))))
            (runs (map (lambda (f)
                         (let ((run (multi-pov-run (:initial f) all-personas '())))
                           (dict :format  (:format f)
                                 :sources (list a b)
                                 :pov     (:pov run)
                                 :entry   (:entry run))))
                       forms))
            (winner (max-by (compose :score :entry) runs)))
       (dict :format    (:format winner)
             :tagline   (:tagline (:entry winner))
             :score     (:score (:entry winner))
             :reactions (:reactions (:entry winner))
             :pov       (:pov winner)
             :sources   (:sources winner))))))

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
       (cond (click           (dict :bucket "clicking"
                                    :tagline (:tagline click)
                                    :reaction (:reaction click)))
             (mismatch        (dict :bucket "audience-miss" :reason mismatch))
             (else            (dict :bucket "unreachable"
                                    :reason (if last-bounce last-bounce "no data")))))
      (else
       (let* ((node     (car rs))
              (reaction (reaction-of-persona-in-node pid node))
              (triage   (triage-of-persona-in-node pid node))
              (click+
                (if (and reaction (clicking? (:verdict reaction)))
                    (dict :tagline (:tagline node) :reaction reaction)
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
           (dict :id       pid
                 :bucket   (:bucket res)
                 :tagline  (:tagline res)
                 :reason   (:reason res)
                 :reaction (:reaction res))))
       personas))

;; ── consolidation: distil bucket reasons into a structured summary ──
(define (reasons-for-template entries)
  (map (lambda (e) (dict :persona (:id e) :reason (:reason e)))
       entries))

(define (consolidate-reasons label entries)
  (cond
    ((null? entries) (dict :summary "" :key-points '()))
    (else
     (consolidate
       (string-concat "/" "consolidate" label
         (string-concat "" (map :id entries)))
       :label   label
       :reasons (reasons-for-template entries)))))

;; ── entry ────────────────────────────────────────────────────────────
(define personas (require "personas.yaml"))

(define initial-personas (values-of personas))
(define results          (optimize-tagline config/initial-tagline initial-personas))
(define buckets          (bucketize results initial-personas))

(dict
  :tree     results
  :compound (compound-of-results results initial-personas)
  :buckets  buckets
  :summaries (dict
                :audience-miss (consolidate-reasons
                                  "not being in our target audience"
                                  (filter (lambda (b) (equal? (:bucket b) "audience-miss")) buckets))
                :unreachable   (consolidate-reasons
                                  "bouncing on every tagline we tried"
                                  (filter (lambda (b) (equal? (:bucket b) "unreachable")) buckets))))
