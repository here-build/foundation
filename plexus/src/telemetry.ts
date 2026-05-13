/**
 * Plexus telemetry adapter.
 *
 * Plug-in seam for emitting Plexus-internal metrics, gauges, histograms,
 * and spans to a host-provided OTel/Prometheus/Datadog/etc backend. Mirrors
 * the `trackingHook` plug-in pattern: zero cost when disabled (default no-op
 * adapter), pay-per-use cost only when a host wires a real adapter via
 * `setTelemetryAdapter(adapter)`.
 *
 * ## Why an adapter, not direct OTel
 *
 * Plexus is a foundations package — published OSS, consumed by here.build
 * studio + (eventually) external users. Direct dependency on `@opentelemetry/api`
 * would force consumers into an OTel ecosystem they may not want. The
 * adapter interface lets each consumer wire their own metric backend (OTel,
 * Prometheus, Datadog, Plexus DevTools, in-memory test capture).
 *
 * ## Cardinality discipline
 *
 * Every Plexus call site passes only **low-cardinality** attribute values
 * (bounded sets per attribute):
 *
 * - `entity_type` — model class name. Bounded by `@syncing`-decorated classes
 *   in the consuming package (~100 for here.build's model). Special value
 *   `"_collection"` when the tracked subject is a proxy collection (owner
 *   plumbing comes in a later stream).
 * - `tracker_kind` — one of `{KEYS, VALUES, ENTRIES_LENGTH, ACCESS_ALL, named}`.
 *   Five values.
 * - `field_kind` — decorator kind: one of `{val, list, set, map, record,
 *   child_list, child_set, child_map, child_record, child, virtual}`. ~10
 *   values. Reserved for future per-field-kind metrics.
 * - `origin_kind` — Plexus transaction origin: `{main, shadow, from_main,
 *   from_shadow, shadow_to_main, liminal, genesis, commit_delta, external}`.
 *   ~8 values.
 *
 * Per OTel/Prometheus convention: never emit unbounded labels on metrics
 * (entity UUIDs, project IDs at client side, doc clientIDs, transaction
 * IDs). Those belong on spans, not counters/gauges/histograms. The Plexus
 * spans created via `telemetry.span(...)` are free to carry such
 * high-cardinality attributes — they're per-event, not aggregated.
 *
 * ## Hot-path discipline
 *
 * `trackAccess` and `trackModification` may fire 100k+ times per second on
 * a heavy edit session. Two design constraints follow:
 *
 * 1. **Zero allocation when adapter is the default no-op.** Callers gate
 *    on `telemetry.enabled` so the attrs object literal is never
 *    constructed when telemetry is off.
 * 2. **Pre-aggregation lives in the adapter, not Plexus.** Plexus emits
 *    per-event counter ticks; the adapter accumulates and exports
 *    periodically (typical: 1Hz).
 *
 * ## Observer-effect budget
 *
 * Per Figma's lesson (their fine-grained per-node instrumentation moved
 * p99 by ~5% and got removed), telemetry on the hot path must stay under
 * a 1–3% budget. The adapter is responsible for instrumenting itself —
 * the `plexus.telemetry.self_overhead_ratio` gauge is the canonical
 * health check.
 */

/* eslint-disable @typescript-eslint/no-empty-function */

/**
 * Attributes attached to a metric or span. Values are coerced to strings
 * by the exporter; pass primitives. Cardinality discipline is enforced
 * at call sites, not here.
 */
export type TelemetryAttributes = Record<string, string | number | boolean>;

/**
 * Adapter consumers implement. All methods are best-effort — adapters
 * should never throw into the call site.
 */
export interface TelemetryAdapter {
  /** Monotonic counter increment. `delta` defaults to 1. */
  counter(name: string, attrs?: TelemetryAttributes, delta?: number): void;
  /** Point-in-time value sample. */
  gauge(name: string, value: number, attrs?: TelemetryAttributes): void;
  /** Distribution sample (latency, size, count, etc.). */
  histogram(name: string, value: number, attrs?: TelemetryAttributes): void;
  /** Begin a span. Caller must call `.end()` (typically in `finally`). */
  span(name: string, attrs?: TelemetryAttributes): TelemetrySpan;
}

/**
 * Span returned by `telemetry.span(...)`. End is idempotent; subsequent
 * calls are no-ops.
 */
export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(attrs?: TelemetryAttributes): void;
}

const NOOP_SPAN: TelemetrySpan = {
  setAttribute() {},
  end() {},
};

const NOOP_ADAPTER: TelemetryAdapter = {
  counter() {},
  gauge() {},
  histogram() {},
  span() {
    return NOOP_SPAN;
  },
};

let activeAdapter: TelemetryAdapter = NOOP_ADAPTER;
let activeEnabled = false;

/**
 * Public telemetry API. Method dispatch goes through `activeAdapter`;
 * when no adapter is installed every call is a no-op closure invocation.
 * Hot-path call sites should still gate on `telemetry.enabled` to avoid
 * allocating the attributes object literal.
 *
 * ```ts
 * if (telemetry.enabled) {
 *   telemetry.counter("plexus.tracking.access", {
 *     entity_type: entityType,
 *     tracker_kind: trackerKind,
 *   });
 * }
 * ```
 */
export const telemetry = {
  get enabled(): boolean {
    return activeEnabled;
  },
  counter(name: string, attrs?: TelemetryAttributes, delta?: number): void {
    activeAdapter.counter(name, attrs, delta);
  },
  gauge(name: string, value: number, attrs?: TelemetryAttributes): void {
    activeAdapter.gauge(name, value, attrs);
  },
  histogram(name: string, value: number, attrs?: TelemetryAttributes): void {
    activeAdapter.histogram(name, value, attrs);
  },
  span(name: string, attrs?: TelemetryAttributes): TelemetrySpan {
    return activeAdapter.span(name, attrs);
  },
};

/**
 * Install a telemetry adapter. Pass `null` to revert to the no-op default.
 * Most consumers call this once at boot; tests reset between cases.
 */
export function setTelemetryAdapter(adapter: TelemetryAdapter | null): void {
  if (adapter === null) {
    activeAdapter = NOOP_ADAPTER;
    activeEnabled = false;
    return;
  }
  activeAdapter = adapter;
  activeEnabled = true;
}

/**
 * Categorical tracker-kind labels for the `tracker_kind` metric attribute.
 * The four symbols from `tracking.ts` plus `named` for string-typed
 * trackers (specific field accessors).
 */
export const TRACKER_KIND = {
  KEYS: "KEYS",
  VALUES: "VALUES",
  ENTRIES_LENGTH: "ENTRIES_LENGTH",
  ACCESS_ALL: "ACCESS_ALL",
  NAMED: "named",
} as const;

export type TrackerKindLabel = (typeof TRACKER_KIND)[keyof typeof TRACKER_KIND];

/**
 * Sentinel used when the tracked subject isn't a PlexusModel (typically
 * a materialized-collection proxy whose owner isn't reachable from the
 * tracking call site). A later stream may plumb owner type through.
 */
export const COLLECTION_ENTITY_TYPE = "_collection";

/**
 * Categorical labels for Yjs transaction origins observed by Plexus's
 * shadow ↔ main forwarding handlers. Each origin maps to a stable
 * string used as the `origin_kind` metric attribute.
 *
 * Bounded cardinality: 8 values + `external` catch-all.
 */
export const ORIGIN_KIND = {
  SHADOW_TO_MAIN: "shadow_to_main",
  FROM_SHADOW: "from_shadow",
  FROM_MAIN: "from_main",
  LIMINAL: "liminal",
  COMMIT_DELTA: "commit_delta",
  GENESIS: "genesis",
  UNDO_MANAGER: "undo_manager",
  /** Any origin not in the Plexus symbol set — application-applied updates, y-websocket, etc. */
  EXTERNAL: "external",
} as const;

export type OriginKindLabel = (typeof ORIGIN_KIND)[keyof typeof ORIGIN_KIND];
