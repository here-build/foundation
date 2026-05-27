/**
 * Repro: cross-doc field update on a locally-constructed-then-attached
 * child entity does NOT reach the JS layer of the constructor side when
 * the inter-doc transport is **y-websocket** (WebsocketProvider).
 *
 * The same scenario passes with:
 *   - synchronous syncDocs (see child-map-field-update-repro.test.ts)
 *   - async bridge via setTimeout(0)            (also that file)
 *   - async bridge with opaque-transport origin (also that file)
 *   - y-protocols sync-protocol mimic           (also that file)
 *
 * Only fails with the real WebsocketProvider. So the bug is in how that
 * provider interacts with Plexus — not in the async/protocol layer in
 * general.
 *
 * Suspect: WebsocketProvider may reset `doc.clientID` or interact with
 * the doc's transactions / observers in a way that disrupts Plexus's
 * shadow doc identity (Plexus.ts:306 — `doc.clientID = newClientId()`,
 * `shadow.clientID = doc.clientID + LIMINAL_BASE`). If a provider attached
 * AFTER bootstrap renegotiates clientID, the shadow's identity drifts.
 *
 * To debug:
 *     cd foundations/plexus
 *     pnpm test src/__tests__/4-cross-document/y-websocket-field-update.test.ts
 *
 * Probe data already collected (in arrival-chain-plexus-cache):
 *   - docB.main update event fires when authority writes ✓
 *   - docB.shadow update event fires (Plexus main→shadow forwarding ok) ✓
 *   - cellB.resultJson read returns null ✗ (this is the failure)
 *   - cellB === rootB.cells.get(key) (same JS instance, same uuid)
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

// Load mobx integration the way arrival-chain does — testing the
// hypothesis that mobx integration changes accessor read behavior in a
// way that breaks cross-doc updates over y-websocket.
import "../../mobx/register.js";
import { setupWSConnection } from "./_setup-ws-connection.js";
import { WebSocket, WebSocketServer } from "ws";

import { syncing } from "../../decorators.js";
import { Plexus } from "../../Plexus.js";
import { PlexusModel } from "../../PlexusModel.js";

@syncing("WSReproCell")
class Cell extends PlexusModel {
  @syncing accessor specJson: string = "";
  @syncing accessor resultJson: string | null = null;
}

@syncing("WSReproRoot")
class Root extends PlexusModel {
  @syncing.child.map accessor cells!: Map<string, Cell>;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("y-websocket cross-doc field update on locally-constructed child", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
  });

  it("locally-constructed cell on client side should reflect authority's field write", async () => {
    // Stand up a y-websocket relay on an ephemeral port.
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (conn, req) => setupWSConnection(conn, req));
    cleanups.push(() => { wss.close(); });

    const ROOM = `wsrepro-${Math.random().toString(36).slice(2)}`;
    const wsUrl = `ws://localhost:${port}`;

    // ── Authority side (bootstrap) ───────────────────────────────────
    const docA = new Y.Doc();
    const rootEntity = new Root({ cells: new Map() });
    const plexusA = Plexus.bootstrap(rootEntity, undefined, docA) as Plexus<Root>;
    const providerA = new WebsocketProvider(wsUrl, ROOM, docA, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    cleanups.push(() => { try { providerA.destroy(); } catch { /* see clientID-swap analysis */ } });
    await new Promise<void>((r) => (providerA as unknown as { once: (e: string, fn: () => void) => void }).once("synced", () => r()));

    // ── Client side (connect) ────────────────────────────────────────
    // Same guid as authority — Plexus uses CRDT-native UUIDs derived
    // from doc.guid (see existing sync.test.ts pattern).
    const docB = new Y.Doc({ guid: docA.guid });
    const providerB = new WebsocketProvider(wsUrl, ROOM, docB, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    cleanups.push(() => { try { providerB.destroy(); } catch { /* see clientID-swap analysis */ } });
    await new Promise<void>((r) => (providerB as unknown as { once: (e: string, fn: () => void) => void }).once("synced", () => r()));

    const plexusB = Plexus.connect(docB) as Plexus<Root>;
    const rootB = plexusB.root;

    // Client locally constructs a child and attaches it.
    const cellB = new Cell({ specJson: "spec-payload" });
    rootB.cells.set("k1", cellB);
    await tick(100); // let the WS round-trip deliver

    // Authority sees the new cell via sync.
    const rootA = plexusA.root;
    const cellA = rootA.cells.get("k1");
    expect(cellA).toBeDefined();
    expect(cellA!.specJson).toBe("spec-payload");

    // Authority writes the resultJson field. Wait explicitly for the
    // update event on docB so we know the round-trip completed.
    const updateOnB = new Promise<void>((r) => docB.once("update", () => r()));
    cellA!.resultJson = "answered-from-A";
    await updateOnB;
    await tick(50); // settle observers after the update lands

    // EXPECTED: the locally-constructed cellB picks up A's write.
    // ACTUAL:   stays null.
    expect(cellB.resultJson).toBe("answered-from-A");
  }, 15000);
});
