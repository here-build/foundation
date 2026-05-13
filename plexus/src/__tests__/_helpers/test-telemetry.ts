import type {
  TelemetryAdapter,
  TelemetryAttributes,
  TelemetrySpan,
} from "../../telemetry.js";

/**
 * Capturing telemetry adapter for tests. Records every emit; query via the
 * `counters`, `gauges`, `histograms`, `spans` properties.
 *
 * Install with `setTelemetryAdapter(adapter)`; reset to no-op with
 * `setTelemetryAdapter(null)` after the test.
 *
 * Counters and gauges accumulate by (name, JSON-stringified-attrs) key —
 * matches the OTel/Prometheus semantic where the metric identity is the
 * tuple of name + attribute set.
 */
export class CapturingTelemetryAdapter implements TelemetryAdapter {
  /** Every counter emit, in arrival order. */
  readonly counterEvents: Array<{ name: string; attrs?: TelemetryAttributes; delta: number }> = [];
  /** Every gauge emit, in arrival order. */
  readonly gaugeEvents: Array<{ name: string; value: number; attrs?: TelemetryAttributes }> = [];
  /** Every histogram emit, in arrival order. */
  readonly histogramEvents: Array<{ name: string; value: number; attrs?: TelemetryAttributes }> = [];
  /** Spans by their ordered creation index. */
  readonly spans: CapturedSpan[] = [];

  counter(name: string, attrs?: TelemetryAttributes, delta = 1): void {
    this.counterEvents.push({ name, attrs, delta });
  }

  gauge(name: string, value: number, attrs?: TelemetryAttributes): void {
    this.gaugeEvents.push({ name, value, attrs });
  }

  histogram(name: string, value: number, attrs?: TelemetryAttributes): void {
    this.histogramEvents.push({ name, value, attrs });
  }

  span(name: string, attrs?: TelemetryAttributes): TelemetrySpan {
    const span = new CapturedSpan(name, attrs);
    this.spans.push(span);
    return span;
  }

  // ── Convenience queries ───────────────────────────────────────────

  /** Counter emits matching `name`. */
  countersByName(name: string): Array<{ attrs?: TelemetryAttributes; delta: number }> {
    return this.counterEvents.filter((e) => e.name === name).map(({ attrs, delta }) => ({ attrs, delta }));
  }

  /** Total delta accumulated across all emits of `name`, optionally filtered by attrs. */
  counterTotal(name: string, attrFilter?: TelemetryAttributes): number {
    return this.counterEvents
      .filter((e) => e.name === name && matchesAttrs(e.attrs, attrFilter))
      .reduce((sum, e) => sum + e.delta, 0);
  }

  /** Histogram samples matching `name`, optionally filtered by attrs. */
  histogramValues(name: string, attrFilter?: TelemetryAttributes): number[] {
    return this.histogramEvents
      .filter((e) => e.name === name && matchesAttrs(e.attrs, attrFilter))
      .map((e) => e.value);
  }

  /** Clear all captured events without reinstalling the adapter. */
  reset(): void {
    this.counterEvents.length = 0;
    this.gaugeEvents.length = 0;
    this.histogramEvents.length = 0;
    this.spans.length = 0;
  }
}

export class CapturedSpan implements TelemetrySpan {
  readonly attributes: Record<string, string | number | boolean> = {};
  readonly endAttributes: TelemetryAttributes | undefined = undefined;
  ended = false;
  endedAt: number | null = null;

  constructor(readonly name: string, initialAttrs?: TelemetryAttributes) {
    if (initialAttrs) Object.assign(this.attributes, initialAttrs);
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  end(attrs?: TelemetryAttributes): void {
    if (this.ended) return; // idempotent per contract
    this.ended = true;
    this.endedAt = Date.now();
    if (attrs) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      Object.assign(self, { endAttributes: attrs });
    }
  }
}

function matchesAttrs(actual: TelemetryAttributes | undefined, filter: TelemetryAttributes | undefined): boolean {
  if (!filter) return true;
  if (!actual) return false;
  for (const key of Object.keys(filter)) {
    if (actual[key] !== filter[key]) return false;
  }
  return true;
}
