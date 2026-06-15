/**
 * HalfBaked — a still-resolving value carrier for speculative (early-collapse)
 * evaluation. See `docs/working-proposals/speculative-evaluation-promise-functor-2026-06-05.md`.
 *
 * The motivating program:
 *
 *   (if (>= (length (filter (lambda (x) (> x 0)) items)) 2) ...alt... ...else...)
 *
 * Today the evaluator awaits the ENTIRE filtered fan before `length` produces a
 * number before `>=` decides the branch. A `HalfBaked` lets the filtered fan
 * reach `length` *un-awaited*: `length` of a partially-settled filtered container
 * is not unknown — it is a NARROWING INTERVAL `[kept-so-far, kept-so-far +
 * pending]`. The instant the lower bound reaches 2, `>= 2` is *certain*, and the
 * branch is taken with promises still outstanding.
 *
 * ── Why this rides on a value, not a sidecar WeakMap ────────────────────────
 * Same reasoning as `AValue.provenance` (see AValue.ts header): a WeakMap keyed
 * by object identity snaps the instant any builtin produces a fresh value. The
 * interval/cardinality summary must travel WITH the value through application
 * boundaries — so `HalfBaked` is a real `AValue` subtype. `is_promise` reports
 * false on it (it has no `then`), so `evaluateArgs` passes it through un-awaited;
 * any operator that does not understand it FORCES it (`force()` → await →
 * collapse to a settled value) — the force-on-unknown-boundary contract.
 *
 * ── Three registers (R0/R1b) ────────────────────────────────────────────────
 * The interval/cardinality summary is register R1b: host-only, give-up-safe,
 * Scheme-invisible. Scheme never sees an interval; it only ever sees the
 * collapsed value (R0). "Unknown" (`undefined` from `decide`) is always a legal
 * answer — the optimizer falls back to forcing, slower but never wrong.
 *
 * ── Not Rx ──────────────────────────────────────────────────────────────────
 * This is `traverse` over a promise functor: 0..1 per edge, not 0..N. Each slot
 * is a one-shot `Promise<SchemeValue[]>` settling once. No scheduler, no
 * subscription, no backpressure. The "streaming" effect is a fan of one-shot
 * promises settling at different times.
 */

import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../interop-access.js";
import { Pair } from "./Pair.js";
import { nil } from "./types.js";

// Loose, like the rest of the interpreter — SchemeValue is `any` in types.ts.
type SchemeValue = any;
type Provenance = ReadonlySet<number>;

/** Closed integer interval `[lo, hi]`. `hi === Infinity` means unbounded above. */
export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Per-slot cardinality: how many items this slot contributes to the collapsed
 * collection. `filter` slots are `[0,1]` until settled (then `[0,0]` dropped or
 * `[1,1]` kept); `map`/`list` slots are `[1,1]` from birth (the value is unknown
 * but the COUNT is not). The length interval is the elementwise sum.
 */
interface SlotRecord {
  cardLo: number;
  cardHi: number;
  settled: boolean;
  /** Resolved payload (0..N items) once settled — used by `refine`. */
  items: SchemeValue[];
}

type SettleListener = () => void;

/**
 * A still-resolving collection or its derived cardinality. One class, two
 * domains, because `length` of a collection HalfBaked is a number HalfBaked that
 * shares the same underlying settle stream:
 *
 *  - `"collection"` — an input-indexed fan of `Promise<SchemeValue[]>` slots.
 *    `force()`/`refine()` folds them to a `Pair`.
 *  - `"number"` — a narrowing integer interval derived from a collection's
 *    cardinality (what `length` returns). `force()` folds to a settled count.
 */
export class HalfBaked extends AValue {
  readonly kind = "halfbaked" as const;

  private readonly domain: "collection" | "number";

  // ── collection domain ──────────────────────────────────────────────────
  private readonly slots: readonly Promise<SchemeValue[]>[];
  private readonly records: SlotRecord[];

  // shared settle machinery (collection owns it; number domain delegates)
  private readonly source: HalfBaked; // self for collection, the list for number
  private readonly listeners: Set<SettleListener>;

  // ── memoized collapse ──────────────────────────────────────────────────
  private forced?: Promise<SchemeValue>;

  private constructor(
    domain: "collection" | "number",
    slots: readonly Promise<SchemeValue[]>[],
    records: SlotRecord[],
    source: HalfBaked | null,
    provenance: Provenance,
  ) {
    super(provenance);
    this.domain = domain;
    this.slots = slots;
    this.records = records;
    this.source = source ?? this;
    this.listeners = source ? source.listeners : new Set();
  }

  /**
   * Build a collection HalfBaked from a fan of slot promises. Each slot resolves
   * to the items it contributes (`[]` dropped, `[x]` kept/mapped). `cardBounds`
   * gives the per-slot `[lo,hi]` before settlement: `[0,1]` for filter, `[1,1]`
   * for map/list.
   */
  static collection(
    slots: readonly Promise<SchemeValue[]>[],
    cardBounds: (index: number) => [number, number],
    provenance: Provenance = EMPTY_PROVENANCE,
  ): HalfBaked {
    const records: SlotRecord[] = slots.map((_, i) => {
      const [cardLo, cardHi] = cardBounds(i);
      return { cardLo, cardHi, settled: false, items: [] };
    });
    const hb = new HalfBaked("collection", slots, records, null, provenance);
    // The single benign `.then` per slot: it ONLY updates the record and
    // notifies listeners. It fires no Scheme work — settlement is driven by the
    // slot promises (already dispatched), the lattice merely OBSERVES status.
    slots.forEach((slot, i) => {
      void Promise.resolve(slot).then(
        (items) => hb.markSettled(i, Array.isArray(items) ? items : [items]),
        // A rejected slot contributes nothing to cardinality and surfaces when
        // `force()` awaits it; settle the record so the interval still narrows.
        () => hb.markSettled(i, []),
      );
    });
    return hb;
  }

  private markSettled(index: number, items: SchemeValue[]): void {
    const rec = this.records[index];
    if (rec.settled) return;
    rec.settled = true;
    rec.items = items;
    rec.cardLo = items.length;
    rec.cardHi = items.length;
    // Notify on the SOURCE's listener set (number-domain views share it).
    for (const l of this.listeners) l();
  }

  /** The cardinality interval right now. lo = Σ cardLo, hi = Σ cardHi. */
  cardinalityInterval(): Interval {
    let lo = 0;
    let hi = 0;
    for (const r of this.records) {
      lo += r.cardLo;
      hi += r.cardHi;
    }
    return { lo, hi };
  }

  /** R1b read for the `number` domain (and identical for collection cardinality). */
  interval(): Interval {
    return this.cardinalityInterval();
  }

  /** True once every slot has settled — the interval has collapsed to a point. */
  get isFullySettled(): boolean {
    return this.source.records.every((r) => r.settled);
  }

  /**
   * `length` of a collection HalfBaked → a number HalfBaked sharing this fan's
   * settle stream. Reading its interval is the early-collapse signal; forcing it
   * folds to the real count.
   */
  toCardinalityNumber(provenance: Provenance = this.provenance): HalfBaked {
    if (this.domain !== "collection") return this;
    return new HalfBaked("number", this.slots, this.records, this, provenance);
  }

  /**
   * Register a listener fired after each slot settles. Returns an unsubscribe.
   * Used by the speculative comparison path to re-test the interval as the fan
   * fills. Registers on the SOURCE so collection + derived number share it.
   */
  onSettle(listener: SettleListener): () => void {
    this.source.listeners.add(listener);
    return () => this.source.listeners.delete(listener);
  }

  /**
   * Give-up-safe early decision. `verdict(interval)` returns a definite value
   * the instant the interval is decisive, or `undefined` to keep waiting. The
   * returned promise resolves as soon as `verdict` is defined — possibly with
   * pending slots still outstanding (the whole point). If the fan fully settles
   * without a verdict, resolves with `verdict` of the collapsed (point) interval
   * — which a correct `verdict` always decides.
   */
  decide<T>(verdict: (interval: Interval) => T | undefined): Promise<T> {
    return new Promise<T>((resolve) => {
      const check = (): boolean => {
        const v = verdict(this.interval());
        if (v !== undefined) {
          resolve(v);
          return true;
        }
        return false;
      };
      if (check()) return;
      const unsubscribe = this.onSettle(() => {
        if (check()) unsubscribe();
      });
    });
  }

  /**
   * Collapse to the data-true value (memoized, like `SchemePromise.force`). For
   * a collection: `Promise.all(slots)` then flatten → `Pair`. For a number: the
   * source collection's settled count. Idempotent — forcing at two boundaries
   * runs the fold once.
   */
  force(): Promise<SchemeValue> {
    if (this.forced) return this.forced;
    if (this.domain === "number") {
      this.forced = this.source.force().then((pair) => pairLength(pair));
      return this.forced;
    }
    this.forced = Promise.all(this.slots).then((slotItems) => {
      const flat: SchemeValue[] = [];
      for (const items of slotItems) {
        if (Array.isArray(items)) flat.push(...items);
        else flat.push(items);
      }
      return arrayToPair(flat, this.provenance);
    });
    return this.forced;
  }

  /** Alias for the fold — the operator's `refine` in the `{pipe, refine}` algebra. */
  refine(): Promise<SchemeValue> {
    return this.force();
  }

  toJs(): unknown {
    // A HalfBaked must never reach serialization un-forced; if it does, the
    // honest representation is its interval (host-debug only — never sent to a
    // Scheme program, which only ever sees the collapsed value).
    const { lo, hi } = this.interval();
    return { __halfBaked__: this.domain, lo, hi };
  }

  withProvenance(p: Provenance): AValue {
    return new HalfBaked(this.domain, this.slots, this.records, this.source, p);
  }
}

markInteropBoundary(HalfBaked);

// ── helpers ─────────────────────────────────────────────────────────────────

function arrayToPair(items: SchemeValue[], provenance: Provenance): SchemeValue {
  const pair = items.length === 0 ? nil : Pair.fromArray(items);
  return provenance && provenance.size > 0 && pair instanceof AValue ? pair.withProvenance(provenance) : pair;
}

function pairLength(pair: SchemeValue): number {
  if (!pair || (pair as { length?: () => number }).length === undefined) return 0;
  const len = (pair as { length: unknown }).length;
  return typeof len === "function" ? (pair as { length: () => number }).length() : (len as number);
}

/** Type guard mirroring `is_promise`'s shape — used by force-on-unknown-boundary. */
export function is_half_baked(o: unknown): o is HalfBaked {
  return o instanceof HalfBaked;
}
