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
;;     personas.json                  baseline personas
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

;; ── system prompts (algorithm-level, not experimental) ──────────────
;;
;; These define WHAT each LM role does in the pipeline. They're part of
;; the program, not per-run config — if you change them, you're changing
;; the algorithm, not running the same algorithm with a different knob.
;; (Per-run knobs live in env; see header.)
(define REACTION-SYSTEM
  "You are a synthetic respondent in a customer-research test. Stay strictly in character — react in the voice of the person described, with their priors, pains, and dealbreakers. Do not soften. Be terse. Output JSON only.")

(define TRIAGE-SYSTEM
  "You evaluate whether a persona's bounce reflects AUDIENCE MISMATCH (category-level rejection) or LATENT FIT (could be reached with different wording). Your DEFAULT verdict is latent fit. Only set mismatch=true with explicit evidence of category-level rejection — the product class, the underlying tech, or the methodology. Wording complaints are NOT mismatch. Output JSON only.")

(define CONSOLIDATION-SYSTEM
  "You distil persona reasoning into a single structured finding. Name the pattern, don't restate the inputs. Be specific. Output JSON only.")

;; The reflection LM is invoked PER POV (see POVS below) — each call gets
;; the POV-typed system prompt, not a single shared one. The only
;; non-POV reflection call is the one-shot merge in compound-of-results;
;; it uses Brand Guardian's system as the safe default.
(define REFLECTION-SYSTEM-FOR-MERGE
  "You are a senior brand strategist. Read the two source taglines and propose a single merged tagline that captures what worked in each. Output JSON only.")

;; ── helpers ──────────────────────────────────────────────────────────
;; entry = (tagline score reactions). cadr/caddr live in BUILTIN_PREAMBLE.
(define (entry-score e) (cadr e))
(define (entry-reactions e) (caddr e))
(define (avg xs) (if (null? xs) 0 (/ (apply + xs) (length xs))))

(define (clicking? v) (or (equal? v "click") (equal? v "keep-reading")))
(define (bouncing? v) (equal? v "bounce"))

(define (state-of persona)
  (field (last (field persona "versions")) "state"))

;; ── schemas ──────────────────────────────────────────────────────────
(define ReactionSchema
  (s/object
    (s/field/string "verdict" "click | keep-reading | bounce")
    (s/field/string "concern" "one-sentence note on what drove the verdict")))

(define ProposalSchema
  (s/object
    (s/field/string "next"      "the next tagline, single line")
    (s/field/string "rationale" "one-line why")))

(define TriageSchema
  (s/object
    (s/field/boolean "mismatch" "true only with explicit category-rejection evidence")
    (s/field/string  "reason")))

(define SummarySchema
  (s/object
    (s/field/string "summary"    "2-3 sentences naming the core pattern, specific not vague")
    (s/field/array  "key-points" (s/array "string"))))

;; ── templates as inline-callable lambdas ─────────────────────────────
(define summary-of-persona     (require "summary-of-persona.hbs"))
(define reaction-prompt        (require "tagline-reaction.hbs"))
(define reflection-prompt      (require "reflection-prompt.hbs"))
(define triage-prompt          (require "triage-prompt.hbs"))
(define consolidation-prompt   (require "consolidation-prompt.hbs"))
(define merge-prompt           (require "merge-prompt.hbs"))

;; ── reactions ────────────────────────────────────────────────────────
(define (reaction-of-persona-tagline persona tagline)
  (car (infer/chat "fast"
         (list (infer/chat/system REACTION-SYSTEM)
               (infer/chat/user
                 (reaction-prompt
                   "summary" (summary-of-persona (state-of persona))
                   "tagline" tagline)))
         ReactionSchema
         (string-append tagline "/" (field persona "id")))))

(define (reactions-of tagline personas)
  (map (lambda (p) (reaction-of-persona-tagline p tagline)) personas))

(define (click-rate reactions)
  (let ((n (length reactions)))
    (if (= n 0) 0
        (/ (count-if (lambda (r) (clicking? (field r "verdict"))) reactions) n))))

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
            (if (clicking? (field (cadr pr) "verdict"))
                (cons (field (car pr) "id") acc) acc))
          '() (map list personas reactions)))

(define (frontier-of history personas inherited)
  (append inherited
    (map (lambda (e) (list (car e) (clickers-of personas (entry-reactions e))))
         history)))

(define (hints-signature hints)
  (apply string-append
    (map (lambda (h) (string-append (car h) ":" (join "," (cadr h)) ";"))
         hints)))

;; ── reflection ───────────────────────────────────────────────────────
(define (reactions-summary reactions personas)
  (map (lambda (p r) (dict "persona" (field p "id")
                           "verdict" (field r "verdict")
                           "concern" (field r "concern")))
       personas reactions))

(define (hints-summary hints)
  (map (lambda (h) (dict "tagline" (car h) "reached" (join ", " (cadr h))))
       hints))

(define (next-tagline current reactions personas hints sys)
  (field (car (infer/chat "high"
                (list (infer/chat/system sys)
                      (infer/chat/user
                        (reflection-prompt
                          "current"   current
                          "reactions" (reactions-summary reactions personas)
                          "hints"     (hints-summary hints))))
                ProposalSchema
                (string-append "reflect/" sys "/" current "/" (hints-signature hints))))
         "next"))

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
(define POVS
  (list
    (dict "name"   "Brand Guardian"
          "system" "You are Brand Guardian — your job is to protect the brand's positioning and voice consistency. Propose taglines that stay true to what the product fundamentally IS. Reject phrasing that drifts toward category-generic or buzzwordy. Output JSON only.")
    (dict "name"   "Growth Hacker"
          "system" "You are Growth Hacker — your job is to maximize click-through. Propose taglines that hook fast: specific, concrete, slightly provocative. Vagueness loses. Output JSON only.")
    (dict "name"   "Product Manager"
          "system" "You are Product Manager — pain-first framing. Propose taglines that name the specific pain the product solves, not the solution category. Concrete > clever. Output JSON only.")
    (dict "name"   "Whimsy Injector"
          "system" "You are Whimsy Injector — anti-bland personality. Propose taglines with a real voice and stance, not corporate default. Output JSON only.")))

;; pov-count selects how many POVs to actually run (1..K). Test rigs
;; pin it to 1 to keep call counts predictable; live runs use all K.
(define (active-povs)
  (take config/pov-count POVS))

(define (multi-pov-run initial personas hints)
  (let ((runs (map (lambda (pov)
                     (let ((entry (gepa-until-plateau initial personas hints (field pov "system"))))
                       (dict "pov" (field pov "name") "entry" entry)))
                   (active-povs))))
    (max-by (lambda (r) (cadr (field r "entry"))) runs)))

;; ── triage ───────────────────────────────────────────────────────────
(define (triage-one persona reaction tagline)
  (let ((v (car (infer/chat "high"
                  (list (infer/chat/system TRIAGE-SYSTEM)
                        (infer/chat/user
                          (triage-prompt
                            "summary" (summary-of-persona (state-of persona))
                            "tagline" tagline
                            "verdict" (field reaction "verdict")
                            "concern" (field reaction "concern"))))
                  TriageSchema
                  (string-append "triage/" tagline "/" (field persona "id"))))))
    (dict "persona"  persona
          "reaction" reaction
          "mismatch" (field v "mismatch")
          "reason"   (field v "reason"))))

(define (triage-bouncers personas reactions tagline)
  (reduce (lambda (pr acc)
            (let ((p (car pr)) (r (cadr pr)))
              (if (bouncing? (field r "verdict"))
                  (cons (triage-one p r tagline) acc) acc)))
          '() (map list personas reactions)))

;; ── worklist driver ──────────────────────────────────────────────────
;; Split into three phases: score (run inner loop + triage), build node
;; record, and (only if recursing) construct the child task. drive then
;; reads as: score → build → route.
(define (score-task task)
  (let* ((personas    (field task "personas"))
         (initial     (field task "initial"))
         (hints       (field task "hints"))
         (run         (multi-pov-run initial personas hints))
         (winning-pov (field run "pov"))
         (best-entry  (field run "entry"))
         (best-tag    (car best-entry))
         (reactions   (caddr best-entry))
         (br          (- 1 (cadr best-entry)))
         (triaged     (if (>= br config/bounce-threshold)
                          (triage-bouncers personas reactions best-tag)
                          '()))
         (unsatisfied (filter (lambda (t) (equal? (field t "mismatch") #f)) triaged)))
    (list best-entry br triaged unsatisfied winning-pov)))

(define (make-node node-id task best-entry br triaged winning-pov)
  (dict "id"          node-id
        "parent-id"   (field task "parent-id")
        "tagline"     (car best-entry)
        "personas"    (map (lambda (p) (field p "id")) (field task "personas"))
        "reactions"   (caddr best-entry)
        "bounce-rate" br
        "triaged"     triaged
        "pov"         winning-pov))

(define (child-task-of parent-task parent-best-entry parent-node-id unsatisfied)
  (let ((personas (field parent-task "personas"))
        (hints    (field parent-task "hints")))
    (dict "personas"  (map (lambda (t) (field t "persona")) unsatisfied)
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
  (field (car (infer/chat "high"
                (list (infer/chat/system REFLECTION-SYSTEM-FOR-MERGE)
                      (infer/chat/user (merge-prompt "a" a "b" b)))
                ProposalSchema
                (string-append "merge-init/" a "|" b)))
         "next"))

(define (compound-of-results results all-personas)
  (cond
    ((< (length results) 2) #f)
    (else
     (let* ((root      (car results))
            (lastnode  (car (reverse results)))
            (a         (field root "tagline"))
            (b         (field lastnode "tagline"))
            (forms (list
                     (dict "format" "concat"
                           "initial" (string-append a ". " b "."))
                     (dict "format" "two-screen"
                           "initial" (string-append a ". On second screen: " b "."))
                     (dict "format" "merge"
                           "initial" (merge-initial a b))))
            (runs (map (lambda (f)
                         (let ((run (multi-pov-run (field f "initial") all-personas '())))
                           (dict "format"  (field f "format")
                                 "sources" (list a b)
                                 "pov"     (field run "pov")
                                 "entry"   (field run "entry"))))
                       forms))
            (winner (max-by (lambda (r) (cadr (field r "entry"))) runs)))
       (dict "format"    (field winner "format")
             "tagline"   (car (field winner "entry"))
             "score"     (cadr (field winner "entry"))
             "reactions" (caddr (field winner "entry"))
             "pov"       (field winner "pov")
             "sources"   (field winner "sources"))))))

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
  (let loop ((ps (field node "personas")) (rs (field node "reactions")))
    (cond ((null? ps) #f)
          ((equal? (car ps) pid) (car rs))
          (else (loop (cdr ps) (cdr rs))))))

(define (triage-of-persona-in-node pid node)
  (let loop ((ts (field node "triaged")))
    (cond ((null? ts) #f)
          ((equal? (field (field (car ts) "persona") "id") pid) (car ts))
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
                (if (and reaction (clicking? (field reaction "verdict")))
                    (list (field node "tagline") reaction)
                    click))
              (mismatch+
                (if (and triage (equal? (field triage "mismatch") #t))
                    (field triage "reason")
                    mismatch))
              (last-bounce+
                (if (and reaction (bouncing? (field reaction "verdict")))
                    (field reaction "concern")
                    last-bounce)))
         (walk (cdr rs) click+ mismatch+ last-bounce+))))))

(define (bucketize results personas)
  (map (lambda (p)
         (let* ((pid (field p "id"))
                (res (persona-result pid results)))
           (dict "id"       pid
                 "bucket"   (field res "bucket")
                 "tagline"  (field res "tagline")
                 "reason"   (field res "reason")
                 "reaction" (field res "reaction"))))
       personas))

;; ── consolidation: distil bucket reasons into a structured summary ──
(define (reasons-for-template entries)
  (map (lambda (e) (dict "persona" (field e "id") "reason" (field e "reason")))
       entries))

(define (consolidate-reasons label entries)
  (cond
    ((null? entries) (dict "summary" "" "key-points" '()))
    (else
     (car (infer/chat "high"
            (list (infer/chat/system CONSOLIDATION-SYSTEM)
                  (infer/chat/user
                    (consolidation-prompt
                      "label"   label
                      "reasons" (reasons-for-template entries))))
            SummarySchema
            (string-append "consolidate/" label "/"
              (apply string-append (map (lambda (e) (field e "id")) entries))))))))

;; ── entry ────────────────────────────────────────────────────────────
(require "personas.json")

(define initial-personas (values-of personas))
(define results          (optimize-tagline config/initial-tagline initial-personas))
(define compound         (compound-of-results results initial-personas))
(define buckets          (bucketize results initial-personas))

(define audience-miss-entries
  (filter (lambda (b) (equal? (field b "bucket") "audience-miss")) buckets))
(define unreachable-entries
  (filter (lambda (b) (equal? (field b "bucket") "unreachable")) buckets))

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
