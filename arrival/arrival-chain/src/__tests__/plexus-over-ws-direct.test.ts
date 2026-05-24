/**
 * Pure Plexus over y-websocket — control for the Plexus mechanics our
 * Program/Project entities depend on. Minimal entity (cell + root with
 * a child.map), no cache or program methods. Confirms cross-doc field
 * updates on locally-constructed children propagate to the other peer's
 * JS reads.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
// eslint-disable-next-line import/no-unresolved
import { setupWSConnection } from "y-websocket/bin/utils";
import { WebSocket, WebSocketServer } from "ws";

import { Plexus, PlexusModel, syncing } from "@here.build/plexus";
import "@here.build/plexus/mobx/register";

@syncing("WsDirectCell")
class Cell extends PlexusModel {
  @syncing accessor specJson: string = "";
  @syncing accessor resultJson: string | null = null;
}

@syncing("WsDirectRoot")
class Root extends PlexusModel {
  @syncing.child.map accessor cells!: Map<string, Cell>;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const onceSynced = (p: WebsocketProvider) =>
  new Promise<void>((r) => (p as unknown as { once: (e: string, fn: () => void) => void }).once("synced", () => r()));

describe("pure Plexus over y-websocket — minimal entity", () => {
  it("locally-constructed cell + cross-doc field update propagates back", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (conn, req) => setupWSConnection(conn, req));

    try {
      const ROOM = `direct-${Math.random().toString(36).slice(2)}`;
      const wsUrl = `ws://localhost:${port}`;

      const docA = new Y.Doc();
      const rootEntity = new Root({ cells: new Map() });
      const plexusA = Plexus.bootstrap(rootEntity, undefined, docA) as Plexus<Root>;
      const providerA = new WebsocketProvider(wsUrl, ROOM, docA, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await onceSynced(providerA);

      const docB = new Y.Doc({ guid: docA.guid });
      const providerB = new WebsocketProvider(wsUrl, ROOM, docB, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await onceSynced(providerB);
      const plexusB = Plexus.connect(docB) as Plexus<Root>;
      const rootB = plexusB.root;

      const cellB = new Cell({ specJson: "spec-payload" });
      rootB.cells.set("k1", cellB);
      await tick(200);

      const rootA = plexusA.root;
      const cellA = rootA.cells.get("k1");
      expect(cellA).toBeDefined();
      expect(cellA!.specJson).toBe("spec-payload");

      const updateOnB = new Promise<void>((r) => docB.once("update", () => r()));
      cellA!.resultJson = "answered-from-A";
      await updateOnB;
      await tick(50);

      expect(cellB.resultJson).toBe("answered-from-A");

      try { providerA.destroy(); } catch { /* awareness cleanup quirk */ }
      try { providerB.destroy(); } catch { /* awareness cleanup quirk */ }
    } finally {
      wss.close();
    }
  }, 15000);
});
