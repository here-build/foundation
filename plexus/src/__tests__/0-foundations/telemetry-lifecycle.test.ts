/**
 * Plexus telemetry — Stream A.2: transaction + liminality lifecycle spans,
 * origin distribution counters/histograms.
 *
 * Covers:
 *   - `plexus.transaction` spans wrap every `maybeTransacting` call;
 *     outcome=commit on success, outcome=abort on throw; duration_ms
 *     set on `end()`.
 *   - Nesting depth attribute reflects call-stack reentry — outer
 *     transaction has nesting_depth=0, nested re-entry sees depth=1.
 *   - `plexus.crdt.shadow_update` + `plexus.crdt.main_update` counters
 *     fire on each Yjs origin observed, tagged with the categorical
 *     origin_kind label (one of ORIGIN_KIND values).
 *   - `plexus.crdt.shadow_update_bytes` + `plexus.crdt.main_update_bytes`
 *     histograms carry update byteLength per emit.
 *   - `plexus.liminality.session` span wraps enter→commit / enter→revert
 *     with outcome attribute. enter/commit/revert counters increment.
 *   - `plexus.liminality.commit_delta_bytes` histogram fires on commit
 *     only (revert produces no delta).
 *   - Cardinality discipline: only categorical labels on metric attrs;
 *     never raw UUIDs / clientIDs / unbounded values.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { ORIGIN_KIND, setTelemetryAdapter } from "../../telemetry.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { CapturingTelemetryAdapter } from "../_helpers/test-telemetry.js";

beforeAll(() => {
  enableMobXIntegration();
});

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("Container")
class Container extends PlexusModel<null> {
  @syncing accessor title: string = "";
  @syncing.list accessor items: string[] = [];
  @syncing.child.list accessor children: Item[] = [];
}

describe("Plexus telemetry — Stream A.2 lifecycle + origin", () => {
  let capture: CapturingTelemetryAdapter;

  beforeEach(() => {
    capture = new CapturingTelemetryAdapter();
    setTelemetryAdapter(capture);
  });

  afterEach(() => {
    setTelemetryAdapter(null);
  });

  describe("plexus.transaction spans", () => {
    it("emits a span per outermost transact with outcome=commit on success", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.transact(() => {
        root.title = "x";
      });

      const txSpans = capture.spans.filter((s) => s.name === "plexus.transaction");
      expect(txSpans.length).toBeGreaterThanOrEqual(1);
      const outerSpan = txSpans.find((s) => s.attributes.nesting_depth === 0);
      expect(outerSpan, "outer-depth span present").toBeDefined();
      expect(outerSpan?.ended).toBe(true);
      // `end()` was called with outcome=commit and a duration_ms attr.
      // The CapturedSpan helper records end-attrs on `endAttributes`.
      expect(outerSpan?.endAttributes?.outcome).toBe("commit");
      expect(typeof outerSpan?.endAttributes?.duration_ms).toBe("number");
    });

    it("emits outcome=abort when the transact body throws", () => {
      const { plexus } = initTestPlexus(new Container());
      capture.reset();

      let caught: unknown = null;
      try {
        plexus.transact(() => {
          throw new Error("user error");
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);

      const aborted = capture.spans.find(
        (s) => s.name === "plexus.transaction" && s.endAttributes?.outcome === "abort",
      );
      expect(aborted, "abort span recorded").toBeDefined();
    });

    it("nested transact reports a depth-1 inner span", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.transact(() => {
        plexus.transact(() => {
          root.title = "nested";
        });
      });

      const txSpans = capture.spans.filter((s) => s.name === "plexus.transaction");
      const depths = txSpans.map((s) => s.attributes.nesting_depth).sort();
      expect(depths.length).toBeGreaterThanOrEqual(2);
      // Outer span at depth 0; at least one inner span at depth ≥ 1.
      expect(depths[0]).toBe(0);
      expect((depths[depths.length - 1] as number) >= 1).toBe(true);
    });
  });

  describe("origin distribution counters / histograms", () => {
    it("emits shadow + main update counters tagged by origin_kind", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.transact(() => {
        root.title = "tracked";
      });

      // A normal write produces shadow→main forwarding. Expect:
      //   - shadow_update with SHADOW_TO_MAIN (the user's write on shadow)
      //   - main_update with SHADOW_TO_MAIN (origin tag preserved on main)
      const shadowEvents = capture.countersByName("plexus.crdt.shadow_update");
      const mainEvents = capture.countersByName("plexus.crdt.main_update");
      expect(shadowEvents.length).toBeGreaterThanOrEqual(1);
      expect(mainEvents.length).toBeGreaterThanOrEqual(1);

      // All origin_kind values come from the bounded ORIGIN_KIND set.
      const allowed = new Set<string>(Object.values(ORIGIN_KIND));
      for (const ev of [...shadowEvents, ...mainEvents]) {
        const kind = ev.attrs?.origin_kind;
        expect(typeof kind).toBe("string");
        expect(allowed.has(String(kind))).toBe(true);
      }
    });

    it("emits update_bytes histograms with positive byteLength values", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.transact(() => {
        root.title = "histograms exercise";
        root.items.push("a", "b", "c");
      });

      const shadowBytes = capture.histogramValues("plexus.crdt.shadow_update_bytes");
      const mainBytes = capture.histogramValues("plexus.crdt.main_update_bytes");
      expect(shadowBytes.length).toBeGreaterThan(0);
      expect(mainBytes.length).toBeGreaterThan(0);
      expect(shadowBytes.every((v) => v > 0)).toBe(true);
      expect(mainBytes.every((v) => v > 0)).toBe(true);
    });

    it("child entity creation produces origin_kind=shadow_to_main or genesis on shadow updates", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.transact(() => {
        root.children.push(new Item({ name: "spawn" }));
      });

      // Child-array push can use either path depending on whether the
      // sub-map is already materialized (SHADOW_TO_MAIN) or fresh
      // (GENESIS via declareDeterministicMap). Either is valid; the
      // assertion is just "we see at least one of them" — proves the
      // origin mapping is wired, not which specific path fires.
      const observed = new Set<string>();
      for (const ev of capture.counterEvents) {
        if (ev.name === "plexus.crdt.shadow_update" && typeof ev.attrs?.origin_kind === "string") {
          observed.add(ev.attrs.origin_kind);
        }
      }
      expect(observed.has(ORIGIN_KIND.SHADOW_TO_MAIN) || observed.has(ORIGIN_KIND.GENESIS)).toBe(true);
    });
  });

  describe("liminality lifecycle spans", () => {
    it("enterLiminality opens a session span; commitLiminality ends with outcome=commit", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.enterLiminality();
      // Some liminal writes — these emit shadow updates with origin=liminal
      root.title = "liminal";
      plexus.commitLiminality();

      const sessions = capture.spans.filter((s) => s.name === "plexus.liminality.session");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.ended).toBe(true);
      expect(sessions[0]?.endAttributes?.outcome).toBe("commit");
      expect(typeof sessions[0]?.endAttributes?.duration_ms).toBe("number");

      expect(capture.counterTotal("plexus.liminality.enter")).toBe(1);
      expect(capture.counterTotal("plexus.liminality.commit")).toBe(1);
      expect(capture.counterTotal("plexus.liminality.revert")).toBe(0);

      // Commit delta bytes histogram recorded.
      expect(capture.histogramValues("plexus.liminality.commit_delta_bytes").length).toBeGreaterThan(0);
    });

    it("revertLiminality ends the session with outcome=revert and emits no commit-delta", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.enterLiminality();
      root.title = "discarded";
      plexus.revertLiminality();

      const sessions = capture.spans.filter((s) => s.name === "plexus.liminality.session");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.endAttributes?.outcome).toBe("revert");

      expect(capture.counterTotal("plexus.liminality.enter")).toBe(1);
      expect(capture.counterTotal("plexus.liminality.commit")).toBe(0);
      expect(capture.counterTotal("plexus.liminality.revert")).toBe(1);
      expect(capture.histogramValues("plexus.liminality.commit_delta_bytes")).toHaveLength(0);
    });

    it("re-entering liminality while already liminal is a no-op (no second span)", () => {
      const { plexus } = initTestPlexus(new Container());
      capture.reset();

      plexus.enterLiminality();
      plexus.enterLiminality(); // no-op per contract
      plexus.commitLiminality();

      expect(capture.spans.filter((s) => s.name === "plexus.liminality.session")).toHaveLength(1);
      expect(capture.counterTotal("plexus.liminality.enter")).toBe(1);
    });
  });

  describe("cardinality discipline", () => {
    it("transaction span attributes are bounded (no uuids, no clientIDs)", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.transact(() => {
        root.title = "no leaks";
        root.children.push(new Item({ name: "x" }));
      });

      const txSpans = capture.spans.filter((s) => s.name === "plexus.transaction");
      for (const span of txSpans) {
        // No uuid-shape attribute values
        for (const [, v] of Object.entries(span.attributes)) {
          expect(String(v)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);
        }
        // Only a small known attribute set
        const allowed = new Set(["has_doc", "nesting_depth", "outcome", "duration_ms"]);
        for (const k of Object.keys(span.attributes)) {
          expect(allowed.has(k), `unexpected span attr ${k}`).toBe(true);
        }
      }
    });

    it("origin_kind on every shadow/main update emit is one of ORIGIN_KIND values", () => {
      const { plexus, root } = initTestPlexus(new Container());
      capture.reset();

      plexus.enterLiminality();
      root.title = "exercise origins";
      plexus.commitLiminality();
      plexus.transact(() => {
        root.title = "more";
      });

      const allowed = new Set<string>(Object.values(ORIGIN_KIND));
      const allOriginEvents = capture.counterEvents.filter(
        (e) => e.name === "plexus.crdt.shadow_update" || e.name === "plexus.crdt.main_update",
      );
      expect(allOriginEvents.length).toBeGreaterThan(0);
      for (const ev of allOriginEvents) {
        expect(allowed.has(String(ev.attrs?.origin_kind))).toBe(true);
      }
    });
  });

  describe("zero-cost when disabled", () => {
    it("emits nothing after setTelemetryAdapter(null)", () => {
      setTelemetryAdapter(null);
      const { plexus, root } = initTestPlexus(new Container());

      plexus.enterLiminality();
      root.title = "silent";
      plexus.commitLiminality();
      plexus.transact(() => {
        root.title = "still silent";
      });

      expect(capture.counterEvents).toHaveLength(0);
      expect(capture.histogramEvents).toHaveLength(0);
      expect(capture.spans).toHaveLength(0);
    });
  });
});
