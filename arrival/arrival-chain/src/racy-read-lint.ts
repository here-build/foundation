/**
 * Racy-read lint for the reflective budget namespace (`(infer/spent)` &c.).
 *
 * `(infer/spent)` is a fold over the run's own inference history — well-defined
 * ONLY at a sequence point, where a data-dependency pins what has settled before
 * the read (see `run-spend.ts`). Placed inside a PARALLEL higher-order form whose
 * arms settle concurrently and out of order, the read is meaningless: "spent
 * relative to which sibling?" has no answer. The racy case IS the meaningless case.
 *
 * Rather than serialize the fan to manufacture a defined value (that would defeat
 * the parallelism the HOF exists for, and the number still wouldn't mean what the
 * author thinks), we surface the read as a static mistake — an errors-as-door
 * diagnostic that names the form and routes the author to the fix: read `spent` in
 * the fold/loop that SEQUENCES the calls (`reduce` / a named-let), not in the `map`
 * arm that fires them in parallel.
 *
 * This is a SHALLOW syntactic pass — like `detectShape`, it duck-types Pair/Symbol
 * and pattern-matches head symbols; no macro expansion, no type analysis. It is
 * deliberately conservative: it flags a reflective read lexically nested inside a
 * parallel-HOF's lambda arm. A read inside a FOLD arm (`reduce`/`fold`) is allowed
 * — the accumulator is threaded sequentially there, so the read sits at a genuine
 * sequence point. Reserve level: the lint reports; it does not block execution (no
 * runtime trap — enforcement is the user loop's base case, not a host throw).
 */

const isPair = (v: unknown): v is { car: unknown; cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

const isSymbol = (v: unknown): v is { __name__: string | symbol; __location__?: SourceLocation } =>
  v !== null && typeof v === "object" && "__name__" in v;

const symName = (s: { __name__: string | symbol }): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** Collect a proper-list Pair chain to a JS array. Non-pair tails are dropped. */
function toArray(p: unknown): unknown[] {
  const out: unknown[] = [];
  let cur = p;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** Head symbol of a call form, or null if not a call. */
function headSymbolOf(form: unknown): string | null {
  if (!isPair(form)) return null;
  const head = (form as { car: unknown }).car;
  if (!isSymbol(head)) return null;
  return symName(head);
}

/**
 * Reflective-budget reads — the symbols whose value is a fold over the run's own
 * inference history, hence sequence-point-only. Mirrors the `infer/*` reflective
 * namespace bound in `buildArrivalEnv`. A bare symbol reference (`infer/spent`
 * passed as a value) counts as a read too, so the lint catches both `(infer/spent)`
 * and `(map (lambda (x) infer/spent) …)`.
 */
const REFLECTIVE_READS: ReadonlySet<string> = new Set(["infer/spent", "infer/calls"]);

/**
 * Parallel higher-order forms — arms settle concurrently / out of order, so a
 * reflective read in an arm is racy. Mirrors `PAR_HOFS` in `ast-shapes.ts`. Folds
 * (`reduce`/`fold`/…) are intentionally EXCLUDED: their arm runs sequentially with
 * a threaded accumulator, so a read there sits at a real sequence point.
 */
const PARALLEL_HOFS: ReadonlySet<string> = new Set([
  "map",
  "for-each",
  "filter",
  "filter-map",
  "find",
  "count-if",
  "some",
  "every",
]);

/** Source position carried by a parsed node, when the parser stamped one. */
export interface SourceLocation {
  line?: number;
  column?: number;
  offset?: number;
}

/** One racy-read finding: a reflective read lexically inside a parallel-HOF arm. */
export interface RacyReadFinding {
  /** The reflective symbol read (`"infer/spent"`). */
  read: string;
  /** The enclosing parallel HOF whose arm the read sits in (`"map"`). */
  enclosingHof: string;
  /** Source position of the read, if the parser stamped one on the node. */
  location?: SourceLocation;
  /** An errors-as-door message: what's wrong + where to move the read. */
  message: string;
}

const isReflectiveRead = (form: unknown): { name: string; location?: SourceLocation } | null => {
  // `(infer/spent)` — a call whose head is a reflective symbol.
  const head = headSymbolOf(form);
  if (head !== null && REFLECTIVE_READS.has(head)) {
    const loc = isPair(form) && isSymbol((form as { car: unknown }).car)
      ? ((form as { car: { __location__?: SourceLocation } }).car.__location__)
      : undefined;
    return { name: head, location: loc };
  }
  // Bare `infer/spent` used as a value (e.g. passed as a HOF callback).
  if (isSymbol(form)) {
    const name = symName(form);
    if (REFLECTIVE_READS.has(name)) return { name, location: form.__location__ };
  }
  return null;
};

const buildMessage = (read: string, hof: string): string =>
  `\`(${read})\` is read inside a parallel \`${hof}\` arm, where it is racy and meaningless ` +
  `— the arms settle out of order, so "spent relative to which sibling?" has no answer. ` +
  `Read \`(${read})\` where the inferences are SEQUENCED instead: in a \`reduce\`/\`fold\` ` +
  `accumulator or a named-let loop, at the point the prior turn has settled.`;

/**
 * Walk a parsed program (the array of top-level forms `parse` returns, or any
 * single form) and report every reflective budget read nested inside a parallel
 * HOF arm.
 *
 * `insideParallel` carries the name of the nearest enclosing parallel HOF down the
 * tree; once set, any reflective read below is a finding. Crucially we DO NOT clear
 * it at a nested fold: a read in `(map (lambda (x) (reduce … (lambda (a y) … (infer/spent)) …)) …)`
 * is still racy w.r.t. the outer `map`, even though the inner `reduce` is itself a
 * sequence point — the outer parallel context dominates. (The inner fold's own
 * accumulator is well-defined; the OUTER map's per-arm `spent` is not.)
 */
export function lintRacyReads(program: unknown): RacyReadFinding[] {
  const findings: RacyReadFinding[] = [];

  const walk = (form: unknown, insideParallel: string | null): void => {
    if (Array.isArray(form)) {
      for (const f of form) walk(f, insideParallel);
      return;
    }

    if (insideParallel !== null) {
      const read = isReflectiveRead(form);
      if (read !== null) {
        findings.push({
          read: read.name,
          enclosingHof: insideParallel,
          location: read.location,
          message: buildMessage(read.name, insideParallel),
        });
        // keep walking — a single arm may hold more than one read
      }
    }

    if (!isPair(form)) return;

    const head = headSymbolOf(form);
    const args = toArray((form as { cdr: unknown }).cdr);

    // A parallel HOF opens (or refreshes) a racy context for its lambda arm(s).
    // The list argument is evaluated in the CURRENT context (it's the data being
    // mapped, fired once), not racily — but distinguishing arg slots precisely is
    // more than a shallow pass should claim. We take the conservative-but-correct
    // stance: the whole subtree under a parallel HOF is the racy region. A literal
    // list `(list a b c)` holds no reflective reads anyway; a reflective read in the
    // list-producing expression would itself be suspect.
    const nextContext = head !== null && PARALLEL_HOFS.has(head) ? head : insideParallel;

    // The head symbol itself was already checked as a bare-read above when this
    // form's PARENT walked it; recurse into the argument forms.
    for (const arg of args) walk(arg, nextContext);
  };

  walk(program, null);
  return findings;
}

// ── Racy MCP-call lint (the server-tape index, G1) ────────────────────────────
//
// The MCP server-tape keys each call POSITIONALLY: (inference, server, nth-call-to-that-
// server). That index is well-defined ONLY in sequential order — it's the read-after-write
// carrier for a server's hidden state. Inside a PARALLEL HOF arm the arms fire out of order,
// so the nth-call index is racy: on replay, a recorded reply may bind to the wrong call, and
// a NON-idempotent call (write/destructive) can be mis-sequenced. This is the same class as
// the reflective-read lint above (a parallel-arm sequence hazard), reusing its AST walk.
//
// Static + conservative: it can't know a tool's idempotency (a runtime `tools/list`
// annotation), so it flags every taped MCP dispatch in a parallel arm. The message says so —
// an idempotent read is harmless; a non-idempotent call must be sequenced. Reports, never
// blocks (enforcement is the author's loop, not a host throw).

/** MCP dispatch forms recorded on the positional server-tape. `mcp/call` is the stateful
 *  one; `infer/agentic/end-to-end` dispatches calls internally (so a parallel arm of agentic
 *  runs races their server tapes). `mcp/list` shares the tape but is a read — included so the
 *  index stays consistent, with the message distinguishing the harmless case. */
const TAPED_MCP_CALLS: ReadonlySet<string> = new Set(["mcp/call", "mcp/list", "infer/agentic/end-to-end"]);

/** One racy-MCP-call finding: a taped dispatch lexically inside a parallel-HOF arm. */
export interface RacyMcpCallFinding {
  /** The MCP dispatch form (`"mcp/call"`). */
  call: string;
  /** The enclosing parallel HOF whose arm the call sits in (`"map"`). */
  enclosingHof: string;
  /** Source position of the call, if the parser stamped one on the node. */
  location?: SourceLocation;
  /** An errors-as-door message: the racy index + how to sequence. */
  message: string;
}

const isTapedMcpCall = (form: unknown): { name: string; location?: SourceLocation } | null => {
  const head = headSymbolOf(form);
  if (head !== null && TAPED_MCP_CALLS.has(head)) {
    const loc =
      isPair(form) && isSymbol((form as { car: unknown }).car)
        ? (form as { car: { __location__?: SourceLocation } }).car.__location__
        : undefined;
    return { name: head, location: loc };
  }
  if (isSymbol(form)) {
    const name = symName(form);
    if (TAPED_MCP_CALLS.has(name)) return { name, location: form.__location__ };
  }
  return null;
};

const buildMcpMessage = (call: string, hof: string): string =>
  `\`(${call} …)\` runs inside a parallel \`${hof}\` arm, where the MCP server-tape index is ` +
  `RACY — the arms fire out of order, so replay can't reconstruct which call was nth to a ` +
  `server. An idempotent read is harmless; a NON-idempotent call (write/destructive) may bind ` +
  `to the wrong recorded reply. Sequence the calls — fire them in a \`reduce\`/\`fold\` or a ` +
  `named-let loop, not a parallel \`${hof}\`.`;

/**
 * Walk a parsed program and report every taped MCP dispatch nested inside a parallel-HOF
 * arm — the server-tape's positional index is racy there. Mirrors {@link lintRacyReads}
 * exactly (same parallel-context dominance: a nested fold does NOT clear the outer parallel
 * region).
 */
export function lintRacyMcpCalls(program: unknown): RacyMcpCallFinding[] {
  const findings: RacyMcpCallFinding[] = [];

  const walk = (form: unknown, insideParallel: string | null): void => {
    if (Array.isArray(form)) {
      for (const f of form) walk(f, insideParallel);
      return;
    }
    if (insideParallel !== null) {
      const call = isTapedMcpCall(form);
      if (call !== null) {
        findings.push({
          call: call.name,
          enclosingHof: insideParallel,
          location: call.location,
          message: buildMcpMessage(call.name, insideParallel),
        });
      }
    }
    if (!isPair(form)) return;
    const head = headSymbolOf(form);
    const args = toArray((form as { cdr: unknown }).cdr);
    const nextContext = head !== null && PARALLEL_HOFS.has(head) ? head : insideParallel;
    for (const arg of args) walk(arg, nextContext);
  };

  walk(program, null);
  return findings;
}
