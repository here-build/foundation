/**
 * Plexus telemetry adapter — tests for Stream A.1.
 *
 * Covers:
 *   - Default no-op adapter (no allocation, no emits)
 *   - `setTelemetryAdapter(null)` reverts to no-op
 *   - `telemetry.enabled` reflects adapter state
 *   - `trackAccess` emits `plexus.tracking.access` with low-cardinality attrs
 *   - `trackModification` emits `plexus.tracking.modification` tagged
 *     with `batched` true/false
 *   - `__untracked__` suppresses modification emits and emits the
 *     `plexus.tracking.untracked_modification` counter instead
 *   - Each tracker symbol maps to its categorical `tracker_kind` label
 *   - PlexusModel entities expose `entity_type` from `__type__`;
 *     non-model subjects fall back to `_collection`
 *   - `flushNotifications` emits `plexus.tracking.flush_batch_size` histogram
 *
 * The cardinality discipline (low-cardinality attribute values only) is
 * encoded in the type-level `TrackerKindLabel` union; structural tests
 * here verify call sites pass exactly those labels.
 */

import { reaction } from "mobx";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import {
  COLLECTION_ENTITY_TYPE,
  setTelemetryAdapter,
  telemetry,
  TRACKER_KIND,
} from "../../telemetry.js";
import {
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  KEYS_SYMBOL,
  trackAccess,
  trackModification,
  VALUES_SYMBOL,
  __untracked__,
} from "../../tracking.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { CapturingTelemetryAdapter } from "../_helpers/test-telemetry.js";

beforeAll(() => {
  enableMobXIntegration();
});

@syncing("Probe")
class Probe extends PlexusModel<null> {
  @syncing accessor name: string = "";
  @syncing.list accessor items: string[] = [];
}

describe("Plexus telemetry adapter — Stream A.1", () => {
  let capture: CapturingTelemetryAdapter;

  beforeEach(() => {
    capture = new CapturingTelemetryAdapter();
    setTelemetryAdapter(capture);
  });

  afterEach(() => {
    setTelemetryAdapter(null);
  });

  describe("adapter lifecycle", () => {
    it("starts disabled by default, becomes enabled when adapter installed", () => {
      setTelemetryAdapter(null);
      expect(telemetry.enabled).toBe(false);

      setTelemetryAdapter(capture);
      expect(telemetry.enabled).toBe(true);
    });

    it("setTelemetryAdapter(null) reverts to no-op", () => {
      setTelemetryAdapter(null);
      // After revert: emits don't reach the previously-installed capture
      const p = new Probe();
      trackAccess(p, "name");
      expect(capture.counterEvents).toHaveLength(0);
    });

    it("default adapter records nothing — confirmed by reading capture before any emits", () => {
      expect(capture.counterEvents).toHaveLength(0);
      expect(capture.gaugeEvents).toHaveLength(0);
      expect(capture.histogramEvents).toHaveLength(0);
      expect(capture.spans).toHaveLength(0);
    });

    it("span() returns a span that ends idempotently", () => {
      const span = telemetry.span("test.span", { kind: "test" });
      expect(capture.spans).toHaveLength(1);
      expect(capture.spans[0]?.name).toBe("test.span");
      expect(capture.spans[0]?.attributes.kind).toBe("test");

      span.end();
      expect(capture.spans[0]?.ended).toBe(true);
      span.end(); // second call no-ops per contract
      expect(capture.spans[0]?.ended).toBe(true);
    });
  });

  describe("trackAccess", () => {
    it("emits plexus.tracking.access counter with entity_type from __type__", () => {
      const p = new Probe();
      trackAccess(p, "name");

      const accesses = capture.countersByName("plexus.tracking.access");
      expect(accesses).toHaveLength(1);
      expect(accesses[0]?.attrs).toEqual({
        entity_type: "Probe",
        tracker_kind: TRACKER_KIND.NAMED,
      });
    });

    it("falls back to _collection entity_type for non-PlexusModel subjects", () => {
      const proxyLike = {}; // no __type__
      trackAccess(proxyLike, "length");

      const accesses = capture.countersByName("plexus.tracking.access");
      expect(accesses).toHaveLength(1);
      expect(accesses[0]?.attrs?.entity_type).toBe(COLLECTION_ENTITY_TYPE);
    });

    it("maps tracker symbols to categorical labels", () => {
      const cases: Array<[symbol, string]> = [
        [KEYS_SYMBOL, TRACKER_KIND.KEYS],
        [VALUES_SYMBOL, TRACKER_KIND.VALUES],
        [ENTRIES_LENGTH_SYMBOL, TRACKER_KIND.ENTRIES_LENGTH],
        [ACCESS_ALL_SYMBOL, TRACKER_KIND.ACCESS_ALL],
      ];
      const subject = {};
      for (const [sym, label] of cases) {
        capture.reset();
        trackAccess(subject, sym);
        const accesses = capture.countersByName("plexus.tracking.access");
        expect(accesses).toHaveLength(1);
        expect(accesses[0]?.attrs?.tracker_kind).toBe(label);
      }
    });

    it("emits string field names as the 'named' tracker kind", () => {
      const p = new Probe();
      trackAccess(p, "name");
      trackAccess(p, "items");

      const accesses = capture.countersByName("plexus.tracking.access");
      expect(accesses).toHaveLength(2);
      for (const acc of accesses) {
        expect(acc.attrs?.tracker_kind).toBe(TRACKER_KIND.NAMED);
      }
    });
  });

  describe("trackModification", () => {
    it("emits plexus.tracking.modification with batched=false outside transactions", () => {
      const p = new Probe();
      trackModification(p, "name");

      const mods = capture.countersByName("plexus.tracking.modification");
      expect(mods).toHaveLength(1);
      expect(mods[0]?.attrs).toEqual({
        entity_type: "Probe",
        tracker_kind: TRACKER_KIND.NAMED,
        batched: "false",
      });
    });

    it("tags modifications inside transact() with batched=true", () => {
      const { plexus, root } = initTestPlexus(new Probe());
      capture.reset(); // discard bootstrap emits

      plexus.transact(() => {
        root.name = "changed";
      });

      const mods = capture.countersByName("plexus.tracking.modification");
      // We expect at least the name field's modification batched.
      // Plexus internals may emit additional modifications; just verify
      // batched=true appears.
      const batched = mods.filter((m) => m.attrs?.batched === "true");
      expect(batched.length).toBeGreaterThan(0);
    });

    it("emits plexus.tracking.flush_batch_size on flush", () => {
      const { plexus, root } = initTestPlexus(new Probe());
      capture.reset();

      plexus.transact(() => {
        root.name = "x";
        root.items.push("a");
        root.items.push("b");
      });

      const flushSizes = capture.histogramValues("plexus.tracking.flush_batch_size");
      expect(flushSizes.length).toBeGreaterThan(0);
      // The transaction batched ≥1 notifications.
      expect(flushSizes.some((s) => s > 0)).toBe(true);
    });
  });

  describe("__untracked__ suppression", () => {
    it("suppresses modification emits and emits untracked_modification instead", () => {
      const p = new Probe();
      // PlexusModel construction fires its own untracked_modification
      // events for default-value initialization. Reset to isolate the
      // assertion to our explicit call.
      capture.reset();

      __untracked__(() => {
        trackModification(p, "name");
      });

      expect(capture.counterTotal("plexus.tracking.modification")).toBe(0);
      expect(capture.counterTotal("plexus.tracking.untracked_modification")).toBe(1);
    });

    it("still emits trackAccess inside __untracked__ (only modification is suppressed)", () => {
      const p = new Probe();
      __untracked__(() => {
        trackAccess(p, "name");
      });

      expect(capture.counterTotal("plexus.tracking.access")).toBe(1);
    });

    it("untracked_modification carries the same entity_type + tracker_kind attrs", () => {
      const p = new Probe();
      capture.reset();

      __untracked__(() => {
        trackModification(p, KEYS_SYMBOL);
      });

      const events = capture.countersByName("plexus.tracking.untracked_modification");
      expect(events).toHaveLength(1);
      expect(events[0]?.attrs).toEqual({
        entity_type: "Probe",
        tracker_kind: TRACKER_KIND.KEYS,
      });
    });
  });

  describe("zero-cost discipline when disabled", () => {
    it("emits nothing after setTelemetryAdapter(null)", () => {
      setTelemetryAdapter(null);
      const p = new Probe();

      trackAccess(p, "name");
      trackModification(p, "name");
      __untracked__(() => {
        trackModification(p, "items");
      });

      expect(capture.counterEvents).toHaveLength(0);
      expect(capture.histogramEvents).toHaveLength(0);
    });

    it("telemetry.enabled is the gate hot-path callers check", () => {
      setTelemetryAdapter(null);
      expect(telemetry.enabled).toBe(false);

      setTelemetryAdapter(capture);
      expect(telemetry.enabled).toBe(true);
    });
  });

  describe("end-to-end via Plexus mutation", () => {
    it("a single MobX-observed mutation emits access + modification + flush", () => {
      const { plexus, root } = initTestPlexus(new Probe());
      capture.reset();

      const dispose = reaction(
        () => root.name,
        () => {
          /* no-op */
        },
      );

      plexus.transact(() => {
        root.name = "tracked";
      });

      expect(capture.counterTotal("plexus.tracking.modification")).toBeGreaterThanOrEqual(1);
      expect(capture.histogramValues("plexus.tracking.flush_batch_size").length).toBeGreaterThan(0);

      // entity_type is populated from PlexusModel's __type__ getter
      const probeMods = capture.counterEvents.filter(
        (e) => e.name === "plexus.tracking.modification" && e.attrs?.entity_type === "Probe",
      );
      expect(probeMods.length).toBeGreaterThanOrEqual(1);

      dispose();
    });

    it("only PlexusModel entity_type values appear under a Probe write — no UUIDs leak as attrs", () => {
      const { plexus, root } = initTestPlexus(new Probe());
      capture.reset();

      plexus.transact(() => {
        root.name = "checked";
      });

      // Confirm no attribute carries a uuid-shape value (a known
      // high-cardinality leak risk).
      for (const ev of capture.counterEvents) {
        for (const v of Object.values(ev.attrs ?? {})) {
          expect(String(v)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);
        }
      }
    });
  });
});
