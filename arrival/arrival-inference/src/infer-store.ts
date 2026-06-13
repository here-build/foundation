import invariant from "tiny-invariant";

import type { Completion, ModelSpec } from "./model.js";
import type { ModelRouter } from "./registry.js";

/**
 * The inference plane — the abstraction "everyone else uses", replacing the CRDT
 * Task plane (cache.ts / task.ts / worker.ts). One content-keyed, single-flight
 * cell per `(spec, cacheKey)`: the FIRST request for a content tuple starts the
 * backend stream; every later request for the same tuple rides the SAME cell (one
 * model call, many subscribers). The cell broadcasts deltas live, caches the final
 * `Completion`, and aborts the underlying request the moment its last subscriber
 * drops — so a superseded run (the browser edited the program) cancels the slow
 * model call for free, via ref-counting, instead of orphaning a CRDT task.
 *
 * Two cache layers, both content-keyed: the in-process `cells` map (single-flight +
 * session cache) and an optional `InferCache` (e.g. a file-backed `.host-cache`)
 * checked on a cell's first run BEFORE the backend — so a completed inference
 * REPLAYS across process restarts instead of regenerating. Determinism is the
 * warrant: a run is a pure function of the body, so a cached completion equals a
 * fresh call's.
 *
 * This lives in arrival-inference (not the OSS runner) so every host shares ONE plane:
 * the headless `evalBody` path, the browser's `POST /infer` SSE path, and the saas
 * Durable Object all resolve inference through the same single-flight cells. The
 * Node disk-cache implementation (`fileCache`) stays host-side; this package only
 * owns the injectable `InferCache` contract + a `noopCache` default.
 */

/** A persisted inference cache: content-keyed read/write of completed `Completion`s,
 *  for cross-restart replay. A miss — or any IO / parse error — resolves to
 *  `undefined`; a failed write is swallowed (the next run just re-infers). The Node
 *  file-backed implementation lives host-side; this package ships only the contract. */
export interface InferCache {
  read(contentKey: string): Promise<Completion | undefined>;
  write(
    contentKey: string,
    key: readonly [model: string, prompt: string, schema: string | null, cacheKey: string | null],
    completion: Completion,
  ): Promise<void>;
}

/** The default: no cross-restart persistence. The in-process cell map still dedups. */
export const noopCache: InferCache = {
  async read() {
    return undefined;
  },
  async write() {},
};

/** The text to seed a cell with on a cache hit / to surface a non-streaming value:
 *  a string is itself; anything structured is its JSON. */
const textOf = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

// Verbose inference tracing — opt-in via `HOST_DEBUG=1`. Prints every cell's
// lifecycle (dispatch → first token → settle/abort) with model + timing, so a
// stall (e.g. LM Studio swapping to a 120B model) is visible as a `→` with no `←`.
// Lives here, on the single inference plane, so it covers EVERY host path.
const VERBOSE = (() => {
  try {
    return !!process.env.HOST_DEBUG;
  } catch {
    return false;
  }
})();
const vlog = (...a: unknown[]): void => {
  if (VERBOSE) console.log("[host:infer]", ...a);
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const keyOf = (spec: ModelSpec, cacheKey: string | null): string =>
  JSON.stringify([spec.model, spec.prompt, spec.schema, cacheKey]);

type DeltaCb = (delta: string) => void;

/** A live inference: subscribe to deltas, await the final, ref-count for abort. */
export interface InferCell {
  /** Text accumulated so far — read it atomically before `onDelta` to replay to a
   *  late subscriber with no gap (both are synchronous, no delta slips between). */
  text(): string;
  /** Whether streaming settled (resolved or rejected). */
  finished(): boolean;
  /** The final completion. Resolves once; rejects on backend failure / abort. */
  readonly done: Promise<Completion>;
  /** Subscribe to live deltas. Returns an unsubscribe. */
  onDelta(cb: DeltaCb): () => void;
  /** Register interest (balance with `release`). */
  acquire(): void;
  /** Drop interest. When the last holder leaves BEFORE completion, the backend
   *  request is aborted (the run was superseded / the client disconnected). */
  release(): void;
}

class Cell implements InferCell {
  private accText = "";
  private settled = false;
  private readonly subs = new Set<DeltaCb>();
  private refs = 0;
  private readonly ac = new AbortController();
  readonly done: Promise<Completion>;

  constructor(
    spec: ModelSpec,
    cacheKey: string | null,
    contentKey: string,
    router: ModelRouter,
    cache: InferCache,
    onSettle: (ok: boolean) => void,
  ) {
    const t0 = Date.now();
    let firstAt = 0;
    this.done = (async () => {
      // Cross-restart replay: a completed call for this exact content is served from
      // the disk cache with no model call. Seed `accText` so a late SSE subscriber
      // still gets the value via the replay path; deltas don't re-fire (it's done).
      const cached = await cache.read(contentKey);
      if (cached) {
        this.accText = textOf(cached.value);
        this.settled = true;
        vlog(`✓ ${spec.model}  CACHED (disk)  ${JSON.stringify(cached.value).slice(0, 60)}`);
        onSettle(true);
        return cached;
      }
      const backend = await router.backendFor(spec.model);
      invariant(!!backend, () => `host: no backend for model "${spec.model}"`);
      vlog(`→ ${spec.model}  prompt=${spec.prompt.length}c  schema=${spec.schema ? "yes" : "no"}`);
      const onFirst = (): void => {
        if (firstAt === 0) {
          firstAt = Date.now();
          vlog(`· ${spec.model}  first token +${firstAt - t0}ms`);
        }
      };
      // The last holder may have released during the (async) backend lookup,
      // before the request was ever issued — don't dispatch a call nobody wants.
      if (this.ac.signal.aborted) throw new DOMException("host: inference aborted before dispatch", "AbortError");
      const completion = backend.stream
        ? await backend.stream(
            spec,
            (d) => {
              onFirst();
              this.emit(d);
            },
            this.ac.signal,
          )
        : await backend.complete(spec).then((c) => {
            // Non-streaming stub: surface the whole value as one delta.
            onFirst();
            this.emit(textOf(c.value));
            return c;
          });
      this.settled = true;
      // Carry the measured wall-clock onto the completion's usage — the values were
      // already computed for the log line below; persisting them lets the cost/time
      // projection layer (pricing.effectiveCloudMs) read per-inference timing instead
      // of discarding it. Local time is the ACTUAL; the cloud projection is derived.
      completion.usage = {
        ...(completion.usage ?? { inputTokens: 0, outputTokens: 0 }),
        durationMs: Date.now() - t0,
        ...(firstAt > 0 ? { ttftMs: firstAt - t0 } : {}),
      };
      vlog(
        `← ${spec.model}  ${Date.now() - t0}ms  in=${completion.usage?.inputTokens ?? 0} out=${completion.usage?.outputTokens ?? 0}  ${JSON.stringify(completion.value).slice(0, 60)}`,
      );
      // Persist BEFORE resolving so a one-shot run (run-folder → process.exit) and an
      // immediate restart both find it on disk. Best-effort inside the cache.
      await cache.write(contentKey, [spec.model, spec.prompt, spec.schema, cacheKey], completion);
      onSettle(true);
      return completion;
    })().catch((error: unknown) => {
      this.settled = true;
      vlog(`✗ ${spec.model}  ${Date.now() - t0}ms  ${this.ac.signal.aborted ? "aborted" : errMsg(error)}`);
      onSettle(false); // error / abort → evict so a re-request retries fresh
      throw error;
    });
  }

  private emit(delta: string): void {
    this.accText += delta;
    for (const cb of this.subs) cb(delta);
  }
  text(): string {
    return this.accText;
  }
  finished(): boolean {
    return this.settled;
  }
  onDelta(cb: DeltaCb): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  acquire(): void {
    this.refs += 1;
  }
  release(): void {
    this.refs -= 1;
    if (this.refs <= 0 && !this.settled) this.ac.abort();
  }
}

/**
 * The inference plane as the project sees it: a thing that vends a live cell per
 * content tuple. `Project.bindInfer` accepts this interface, not the concrete
 * class, so a host can plug in any cell source — the Node/DO `InferStore` over a
 * `ModelRouter` (below), or the browser studio's SSE-backed store that forwards
 * each `(infer …)` to the server's `POST /infer` (where the API keys live) and
 * rides the streamed deltas back. Both satisfy the same single-flight contract;
 * the evaluator (`inferAndWait`) is identical across hosts.
 */
export interface InferStoreLike {
  get(spec: ModelSpec, cacheKey: string | null): InferCell;
}

/** Content-keyed single-flight store over a `ModelRouter`, optionally backed by a
 *  persisted `InferCache` for cross-restart replay. */
export class InferStore implements InferStoreLike {
  private readonly cells = new Map<string, Cell>();
  constructor(
    private readonly router: ModelRouter,
    private readonly cache: InferCache = noopCache,
  ) {}

  /** Get (or start) the cell for this content tuple. Starting is eager: the first
   *  `get` for a tuple kicks off the run (a disk-cache check, then the backend on a
   *  miss) immediately. */
  get(spec: ModelSpec, cacheKey: string | null): InferCell {
    const key = keyOf(spec, cacheKey);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new Cell(spec, cacheKey, key, this.router, this.cache, (ok) => {
        if (!ok) this.cells.delete(key); // failed / aborted → free the slot for a retry
      });
      this.cells.set(key, cell);
    }
    return cell;
  }
}

export const createInferStore = (router: ModelRouter, cache: InferCache = noopCache): InferStore =>
  new InferStore(router, cache);

/**
 * The trace-side record of ONE `(infer …)` invocation — the cell-plane replacement
 * for the old synced `InferenceTask`. Bound to its invocation(s) via
 * `trace.bindTask`, it carries the content tuple (for cost attribution + content
 * display) plus a live `cell` and a `completion` field stamped the moment the cell
 * settles. The infer closure awaits `cell.done` and writes `completion`, so by the
 * time a run finishes every binding's usage is synchronously readable — that's what
 * lets `runCostSummary` stay a synchronous walk over already-resolved bindings.
 *
 * Distinct from the cell itself because N invocations across HOF iterations may
 * share ONE content-keyed cell (single-flight dedup); each invocation still gets its
 * own binding so provenance / cost attribution stays per-site, while the underlying
 * model call fires once.
 */
export class InferBinding {
  /** The provider result, stamped when `cell.done` resolves; undefined while pending
   *  or on error. Cost + content read this after the run's awaits settle. */
  completion: Completion | undefined = undefined;

  constructor(
    readonly model: string,
    readonly prompt: string,
    readonly schema: string | null,
    readonly cacheKey: string | null,
    readonly cell: InferCell,
  ) {}
}
