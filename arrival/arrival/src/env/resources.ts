// resources — the env's PORTS (Erlang ports / TC39 disposables), as a FACTORY.
//
// A `Resource<H>` is a factory of disposables: each `acquire` mints a fresh handle
// whose teardown is a TC39 `Symbol.asyncDispose`. The factory wrapper around it —
// `ResourceCell` — adds the one thing the TC39 spec deliberately omits: the
// RE-ACQUIRABLE CYCLE. From that single seam fall three behaviours, all the same
// operation (`get()` — acquire-if-needed, single-flight):
//   • LAZY spawn        — nobody calls get() until a wired symbol is first used →
//                         the port opens on first access, not at spin-up.
//   • PARALLEL acquire  — N concurrent get()s share ONE in-flight acquire; a group
//                         of cells warms via Promise.all.
//   • RECONSTRUCTION    — wind-down disposes the handle; the next get() opens a
//                         FRESH one (resume / on-demand respawn). The Ref is stable.
//
// The TC39 reuse is exact: the handle's release IS `[Symbol.asyncDispose]`; this
// module never reinvents disposal, only the cycle around it.

/** A typed, cyclable boundary to something external — an Erlang port. `kind` is the
 *  driver class ("socket"); H is the handle CONTRACT consumers depend on. Two
 *  drivers (ws / udp) share a kind, differ in `acquire`. */
export interface Resource<H> {
  readonly kind: string;
  /** Open the port → a handle carrying its own async teardown. MUST honor
   *  `ctx.signal` if present (reject, or open-then-the-cell-disposes, if aborted). */
  acquire(ctx: AcquireCtx): Promise<H & AsyncDisposable>;
}

export interface AcquireCtx {
  /** Aborts this acquire (the spin-up / resume window it belongs to). `undefined`
   *  when there is no abort window — a never-aborting acquire. */
  readonly signal?: AbortSignal;
  /** The C3 linearization of the assembly — audit only. */
  readonly order: readonly string[];
}

/** The stable port-id handed to wiring. The handle behind it is swapped on every
 *  acquire (fresh after each resume); the Ref identity never changes. */
export interface Ref<H> {
  readonly kind: string;
  /** Acquire-if-needed (single-flight, lazy), resolve the live handle. Re-opens
   *  on-demand after a wind-down. Rejects if the controlling signal aborts. */
  get(): Promise<H>;
  /** The live handle, SYNCHRONOUSLY. Throws `ResourceNotLiveError` if not yet
   *  spawned — methods use this, relying on the env accessor having pre-spawned all
   *  the capability's resources before the symbol was reachable. */
  readonly live: H;
  /** The live handle iff currently open — never triggers an acquire. */
  peek(): H | undefined;
  readonly isLive: boolean;
}

/** A method touched a resource that the env accessor should have pre-spawned. */
export class ResourceNotLiveError extends Error {
  constructor(public readonly kind: string) {
    super(
      `resource "${kind}" was accessed via .live before it was spawned. The env accessor pre-spawns a ` +
        `capability's resources on first symbol touch — if you see this, the method ran outside that gate ` +
        `(use .get() for an explicit lazy acquire instead).`,
    );
    this.name = "ResourceNotLiveError";
  }
}

/** Wrap a plain `value + close()` into a disposable handle — so a driver author
 *  needn't implement the symbol by hand. `(s) => s.close()` is the usual closer. */
export function port<H extends object>(value: H, close: () => PromiseLike<void> | void): H & AsyncDisposable {
  return Object.assign(value, {
    [Symbol.asyncDispose]: async () => {
      await close();
    },
  });
}

/** The per-resource factory: a `Ref` backed by single-flight, re-acquirable state.
 *  One cell ←→ one port; the env holds a cell per `ctx.use(resource)`. */
export class ResourceCell<H> implements Ref<H> {
  readonly kind: string;
  readonly #resource: Resource<H>;
  #handle: (H & AsyncDisposable) | undefined;
  #inflight: Promise<H> | undefined;
  /** The abort window for the current spin-up/resume; armed by `spinUp`.
   *  `undefined` = no window (a never-aborting cell). */
  #signal?: AbortSignal;

  constructor(resource: Resource<H>) {
    this.#resource = resource;
    this.kind = resource.kind;
  }

  get isLive(): boolean {
    return this.#handle !== undefined;
  }

  peek(): H | undefined {
    return this.#handle;
  }

  /** Synchronous live handle — throws if not spawned. See `Ref.live`. */
  get live(): H {
    if (this.#handle === undefined) throw new ResourceNotLiveError(this.kind);
    return this.#handle;
  }

  /** Arm the abort window for this lifecycle pass. `eager` pre-warms (acquire now);
   *  omit it for a LAZY port (opens on first `get()` — i.e. first symbol use). */
  async spinUp(signal?: AbortSignal, eager = false): Promise<void> {
    this.#signal = signal;
    if (eager) await this.get();
  }

  get(): Promise<H> {
    if (this.#handle !== undefined) return Promise.resolve(this.#handle);
    // Single-flight: concurrent callers (and a group's parallel warm) share one acquire.
    this.#inflight ??= this.#acquire();
    return this.#inflight;
  }

  async #acquire(): Promise<H> {
    const signal = this.#signal;
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const handle = await this.#resource.acquire({ signal, order: [] });
      // Aborted WHILE opening → dispose the just-opened handle so nothing leaks.
      if (signal?.aborted) {
        await handle[Symbol.asyncDispose]();
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      this.#handle = handle;
      return handle;
    } catch (error) {
      // Failed/aborted acquire: drop in-flight so the NEXT get() retries (respawn).
      throw error;
    } finally {
      this.#inflight = undefined;
    }
  }

  /** Wind down (pause): dispose the current handle; the cell stays re-acquirable.
   *  Idempotent. A concurrent in-flight acquire is settled first to avoid a leak. */
  async windDown(): Promise<void> {
    if (this.#inflight !== undefined) {
      await this.#inflight.catch(() => {});
    }
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.[Symbol.asyncDispose]();
  }
}

/** Warm a set of cells in PARALLEL (single-flight makes this safe to over-call). */
export function spinUpAll(cells: readonly ResourceCell<unknown>[], signal?: AbortSignal): Promise<void> {
  return Promise.all(cells.map((c) => c.spinUp(signal, true))).then(() => undefined);
}

/** Wind down a set in REVERSE order (dependents before deps — LIFO), best-effort. */
export async function windDownAll(cells: readonly ResourceCell<unknown>[]): Promise<void> {
  for (let i = cells.length - 1; i >= 0; i--) {
    await cells[i]!.windDown().catch(() => {});
  }
}
