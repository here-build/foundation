// env-pack.ts — capability-DAG assembly for arrival environments (P0: the pure core).
//
// A pack is a named, dependency-carrying, async capability contribution to an env. Environments are
// assembled by C3-linearizing the pack DAG and applying each pack once. The dep edge IS the
// capability grant; the DAG is the authoring form, the assembled env is the flat runtime form.
//
// Design: docs/working-proposals/env-pack-capability-dag-2026-06-13.md
//
// P0 scope: the env-agnostic core — closure + cycle detection, identity dedup, C3 linearization
// (Python MRO, cited not invented), and the apply loop with LIFO disposal + per-pack apply timeout.
// No consumer wires it yet (that is P1: buildArrivalEnv-as-one-pack).

/** A capability contribution to an env. Identity = (name, config). `deps` are the DAG edges. */
export interface EnvPack<E = unknown> {
  readonly name: string;
  readonly deps?: readonly EnvPack<E>[];
  /** Host-injected arming for THIS pack (inferPack.config = the InferFn, mcpPack.config = the
   *  resolver). Two same-name packs with non-equal config in one assembly = AssembleConfigConflictError. */
  readonly config?: unknown;
  /** Runs once, after all deps, in C3 order. May await import / defineRosetta / ctx.onDispose.
   *  MUST contribute symbols via the env's membrane-wrapping API, never a bare host closure (§8). */
  apply(env: E, ctx: PackContext): void | Promise<void>;
}

export interface PackContext {
  /** Register a teardown thunk; run LIFO by AssembledEnv.dispose(). */
  onDispose(fn: () => void | Promise<void>): void;
  /** The C3 linearization this pack sits in (highest precedence first) — debug/audit. */
  readonly order: readonly string[];
}

export interface AssembledEnv<E = unknown> {
  readonly env: E;
  /** The C3 linearization, highest precedence (roots) first. */
  readonly order: readonly string[];
  dispose(): Promise<void>;
}

// ── Errors (teaching, errors-as-doors) ───────────────────────────────────────
export class AssembleCycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(
      `env-pack dependency cycle: ${cycle.join(" → ")}. Packs form a DAG; break the edge ` +
        `(or model a genuine mutual as a declare-then-wire two-phase pack).`,
    );
    this.name = "AssembleCycleError";
  }
}
export class AssembleConfigConflictError extends Error {
  constructor(public readonly packName: string) {
    super(
      `env-pack "${packName}" appears twice in one assembly with different config. One name = one ` +
        `config per assembly — you armed the same capability two ways. Dedup the pack or unify the config.`,
    );
    this.name = "AssembleConfigConflictError";
  }
}
export class AssembleLinearizationError extends Error {
  constructor(public readonly packName: string) {
    super(
      `env-pack "${packName}" has an inconsistent dependency precedence (C3 merge failed): a dep ` +
        `ordering contradicts another. Reorder the conflicting deps so a single linearization exists.`,
    );
    this.name = "AssembleLinearizationError";
  }
}
export class AssemblePackError extends Error {
  constructor(
    public readonly packName: string,
    public readonly cause: unknown,
  ) {
    super(`env-pack "${packName}" failed to apply: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AssemblePackError";
  }
}
export class AssemblePackTimeoutError extends Error {
  constructor(
    public readonly packName: string,
    public readonly ms: number,
  ) {
    super(`env-pack "${packName}" did not finish applying within ${ms}ms (a wedged await import?).`);
    this.name = "AssemblePackTimeoutError";
  }
}

const packTimeoutMs = (): number => Number(process.env.ASSEMBLE_PACK_TIMEOUT_MS) || 30_000;

/** Structural-or-identity config equality: reference-equal (functions, resolvers) OR deep-equal
 *  for plain data. Functions are never structurally equal — only the same reference dedups. */
function configEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "function" || typeof b === "function") return false; // identity-only
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => configEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** DFS the dep DAG from roots: collect packs by name, detect cycles (3-color), check config dedup. */
function closure<E>(roots: readonly EnvPack<E>[]): Map<string, EnvPack<E>> {
  const byName = new Map<string, EnvPack<E>>();
  const GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (pack: EnvPack<E>): void => {
    const seen = byName.get(pack.name);
    if (seen !== undefined && !configEqual(seen.config, pack.config)) throw new AssembleConfigConflictError(pack.name);
    if (color.get(pack.name) === BLACK) return; // already fully visited
    if (color.get(pack.name) === GRAY) {
      const from = stack.indexOf(pack.name);
      throw new AssembleCycleError([...stack.slice(from), pack.name]);
    }
    color.set(pack.name, GRAY);
    stack.push(pack.name);
    byName.set(pack.name, pack);
    for (const dep of pack.deps ?? []) visit(dep);
    stack.pop();
    color.set(pack.name, BLACK);
  };

  for (const r of roots) visit(r);
  return byName;
}

/** C3 linearization (Python MRO) over the deduped pack graph. Returns names, highest precedence
 *  first. `merge` repeatedly takes a "good head" (a head appearing in no list's tail). */
function c3Linearize<E>(roots: readonly EnvPack<E>[], byName: Map<string, EnvPack<E>>): string[] {
  const memo = new Map<string, string[]>();

  const lin = (name: string): string[] => {
    const cached = memo.get(name);
    if (cached) return cached;
    const pack = byName.get(name)!;
    // Dedupe dep NAMES: two same-name deps (or a pack listing one dep twice) are one node after
    // identity-dedup, so the linearization lists must carry it once — else the [deps] list holds a
    // duplicate that has no valid C3 "good head" (it appears in its own tail).
    const deps = [...new Set((pack.deps ?? []).map((d) => d.name))];
    const lists: string[][] = [...deps.map((d) => lin(d)), [...deps]];
    const merged = merge(lists, name);
    const result = [name, ...merged];
    memo.set(name, result);
    return result;
  };

  // A synthetic top depending on all roots gives the total order; drop the synthetic head.
  const rootNames = [...new Set(roots.map((r) => r.name))];
  const top = merge([...rootNames.map((n) => lin(n)), [...rootNames]], "<assembly-root>");
  return dedupeStable(top);
}

/** A "good head" for C3 merge: the first list-head that appears in no list's TAIL (non-head
 *  position). Returns undefined when none exists (an inconsistent hierarchy). */
function findGoodHead(work: string[][]): string | undefined {
  for (const list of work) {
    const candidate = list[0];
    const inSomeTail = work.some((l) => l.slice(1).includes(candidate));
    if (!inSomeTail) return candidate;
  }
  return undefined;
}

function merge(lists: string[][], owner: string): string[] {
  const out: string[] = [];
  const work = lists.map((l) => [...l]).filter((l) => l.length > 0);
  while (work.length > 0) {
    const head = findGoodHead(work);
    if (head === undefined) throw new AssembleLinearizationError(owner);
    out.push(head);
    for (let i = work.length - 1; i >= 0; i--) {
      if (work[i][0] === head) work[i].shift();
      if (work[i].length === 0) work.splice(i, 1);
    }
  }
  return out;
}

function dedupeStable(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names)
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  return out;
}

function withTimeout<T>(p: Promise<T> | T, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AssemblePackTimeoutError(name, ms)), ms);
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Assemble `base` into a capability-scoped env by resolving the pack DAG. Async by construction
 * (a pack may await import / spin up a resource). Applies each pack once in C3 order
 * (least-precedence first ⇒ last-write-wins matches C3). On any apply failure, runs the disposers
 * collected so far (LIFO) and rejects — no half-built env escapes.
 */
/** Shared sync core: closure + cycle-detect + dedup + C3 linearization. Returns the apply order
 *  (highest precedence first) and the deduped packs by name. */
function linearize<E>(roots: readonly EnvPack<E>[]): { order: string[]; byName: Map<string, EnvPack<E>> } {
  const byName = closure(roots);
  const order = c3Linearize(roots, byName);
  return { order, byName };
}

function makeCtx(order: string[]): { ctx: PackContext; runDisposers: () => Promise<void> } {
  const disposers: Array<() => void | Promise<void>> = [];
  const ctx: PackContext = { onDispose: (fn) => disposers.push(fn), order };
  const runDisposers = async () => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        await disposers[i]();
      } catch {
        /* best-effort teardown */
      }
    }
  };
  return { ctx, runDisposers };
}

/**
 * Assemble `base` into a capability-scoped env by resolving the pack DAG. Async by construction.
 * Applies each pack once in C3 order (least-precedence first ⇒ last-write-wins matches C3). On any
 * apply failure, runs disposers collected so far (LIFO) and rejects — no half-built env escapes.
 */
export async function assembleEnv<E>(base: E, roots: readonly EnvPack<E>[]): Promise<AssembledEnv<E>> {
  const { order, byName } = linearize(roots);
  const { ctx, runDisposers } = makeCtx(order);
  for (const name of order.toReversed()) {
    const pack = byName.get(name)!;
    try {
      await withTimeout(pack.apply(base, ctx), packTimeoutMs(), name);
    } catch (error) {
      await runDisposers();
      if (error instanceof AssemblePackTimeoutError) throw error;
      throw new AssemblePackError(name, error);
    }
  }
  return { env: base, order, dispose: runDisposers };
}

/**
 * Synchronous assembly — for envs whose packs are all sync (e.g. the legacy core that only
 * registers rosettas). Shares the same linearize core. Throws AssemblePackError if any pack's
 * apply returns a thenable (use the async `assembleEnv` for async packs). This is the sync seam
 * that keeps `buildArrivalEnv` callable from a sync constructor until chain construction itself
 * is moved into an async `init()` (the point at which async packs — e.g. the progress server —
 * become expressible and the sync path retires).
 */
/** A live-env assembler for RUNTIME pack application — the `(require/extension :name)` path. Where
 *  `assembleEnv` builds a fresh env once at construction, this applies registered packs onto an
 *  ALREADY-LIVE env mid-run, idempotently and single-flight (a second require of the same pack — or a
 *  concurrent one from a parallel HOF arm — awaits the one in-flight apply, never re-applies). Each
 *  pack's deps are applied first in C3 order, and a pack reached two ways applies once. Disposers are
 *  collected for a single LIFO `dispose()` tied to the env's teardown. */
export interface RuntimeAssembler<E = unknown> {
  /** Apply `pack` (and any not-yet-applied deps) to the live env, in C3 order. Idempotent. */
  require(pack: EnvPack<E>): Promise<void>;
  /** Tear down every runtime-applied pack, LIFO (reverse of apply order). */
  dispose(): Promise<void>;
}

export function createRuntimeAssembler<E>(env: E): RuntimeAssembler<E> {
  // name → the in-flight-or-settled apply promise. Presence = APPLYING|APPLIED (single-flight key);
  // a rejecting apply deletes its entry so a later require may retry (FAILED → APPLYING).
  const applied = new Map<string, Promise<void>>();
  const disposers: Array<() => void | Promise<void>> = [];

  const applyOne = (name: string, pack: EnvPack<E>, order: readonly string[]): Promise<void> => {
    const existing = applied.get(name);
    if (existing) return existing; // idempotent + single-flight (no await between get and set below)
    const ctx: PackContext = { onDispose: (fn) => disposers.push(fn), order };
    // The async IIFE turns a SYNCHRONOUS throw in apply() into a rejection so the catch handles it
    // uniformly (a bare `pack.apply(...)` would throw before withTimeout was even called).
    const p = (async () => withTimeout(pack.apply(env, ctx), packTimeoutMs(), name))().catch((error) => {
      applied.delete(name); // FAILED: drop so a re-require retries; the pack's own disposers ran via ctx
      if (error instanceof AssemblePackTimeoutError) throw error;
      throw new AssemblePackError(name, error);
    });
    applied.set(name, p);
    return p;
  };

  const require = async (pack: EnvPack<E>): Promise<void> => {
    const { order, byName } = linearize([pack]);
    // Apply least-precedence (deps) first, matching construction's last-write-wins order.
    for (const name of order.toReversed()) await applyOne(name, byName.get(name)!, order);
  };

  const dispose = async (): Promise<void> => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        await disposers[i]();
      } catch {
        /* best-effort teardown */
      }
    }
  };

  return { require, dispose };
}
