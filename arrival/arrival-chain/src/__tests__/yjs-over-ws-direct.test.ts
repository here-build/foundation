/**
 * Pure yjs over y-websocket — NO Plexus at all. Confirms the transport
 * itself works for both top-level and nested map field updates.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { setupWSConnection } from "./_setup-ws-connection.js";
import { WebSocket, WebSocketServer } from "ws";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("pure yjs over y-websocket — control", () => {
  it("nested map field updates propagate both directions", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (conn, req) => setupWSConnection(conn, req));

    try {
      const ROOM = `yjs-${Math.random().toString(36).slice(2)}`;
      const wsUrl = `ws://localhost:${port}`;

      const docA = new Y.Doc();
      const pA = new WebsocketProvider(wsUrl, ROOM, docA, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await new Promise<void>((r) =>
        (pA as unknown as { once: (e: string, fn: () => void) => void }).once("synced", () => r()),
      );

      const docB = new Y.Doc({ guid: docA.guid });
      const pB = new WebsocketProvider(wsUrl, ROOM, docB, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await new Promise<void>((r) =>
        (pB as unknown as { once: (e: string, fn: () => void) => void }).once("synced", () => r()),
      );

      const cellsB = docB.getMap<Y.Map<unknown>>("cells");
      const cellB = new Y.Map<unknown>();
      cellsB.set("k1", cellB);
      cellB.set("specJson", "spec-payload");
      await tick(100);

      const cellsA = docA.getMap<Y.Map<unknown>>("cells");
      const cellA = cellsA.get("k1");
      expect(cellA).toBeDefined();
      expect(cellA!.get("specJson")).toBe("spec-payload");

      const updateOnB = new Promise<void>((r) => docB.once("update", () => r()));
      cellA!.set("resultJson", "answered-from-A");
      await updateOnB;
      await tick(50);

      expect(cellB.get("resultJson")).toBe("answered-from-A");

      try { pA.destroy(); } catch { /* awareness cleanup quirk */ }
      try { pB.destroy(); } catch { /* awareness cleanup quirk */ }
    } finally {
      wss.close();
    }
  }, 15000);
});
