import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
// eslint-disable-next-line import/no-unresolved
import { setupWSConnection } from "y-websocket/bin/utils";
import { WebSocket, WebSocketServer } from "ws";

import { ArrivalChain } from "../arrival-chain.js";
import type { ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { runProjectWorker } from "../worker.js";

const stubModel = () => ({
  complete: async (s: ModelSpec) => `echo(${s.model}):${s.prompt}`,
});

/**
 * Production topology in-process: designated server bootstraps the
 * Project on a fresh room doc, runs `runProjectWorker` to drain tasks
 * across every scheduled program. A client connects to the same room,
 * picks up its Project, schedules a program, and awaits the result —
 * which the server-side worker fills.
 *
 * Requires `yjs` aliased to a single module instance in vitest config
 * (`Plexus.bootstrap/connect`'s `instanceof Y.Doc` guard catches mismatches).
 */

const onceSynced = (p: WebsocketProvider) =>
  new Promise<void>((r) => (p as unknown as { once: (e: string, fn: () => void) => void }).once("synced", () => r()));

describe("Project — cross-process via y-websocket relay", () => {
  it("client schedules a program; server-side worker fills it; client awaits result", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (conn, req) => setupWSConnection(conn, req));

    const wsUrl = `ws://localhost:${port}`;
    const ROOM = `proj-${Math.random().toString(36).slice(2)}`;

    try {
      // ── Server side ──────────────────────────────────────────────
      const docServer = new Y.Doc();
      const projectServer = ArrivalChain.bootstrap(new Project(), undefined, docServer).root;
      const providerServer = new WebsocketProvider(wsUrl, ROOM, docServer, {
        WebSocketPolyfill: WebSocket,
      });
      await onceSynced(providerServer);

      const ac = new AbortController();
      const draining = runProjectWorker(projectServer, { backends: stubModel(), signal: ac.signal });

      // ── Client side ──────────────────────────────────────────────
      const docClient = new Y.Doc({ guid: docServer.guid });
      const providerClient = new WebsocketProvider(wsUrl, ROOM, docClient, {
        WebSocketPolyfill: WebSocket,
      });
      await onceSynced(providerClient);
      const projectClient = ArrivalChain.connect(docClient).root;

      // Client adds a program (creates file in `files`, schedules into `programs`).
      const program = projectClient.addProgram(
        "demo",
        `(define a (car (infer "m" "p1"))) (car (infer "m" (string-append a "/p2")))`,
      );

      // taskResolver path: client emits tasks; server-side worker fills.
      const value = await program.run();

      expect(typeof value).toBe("string");
      expect(value).toContain("echo(m):");

      ac.abort();
      await draining;
      try { providerServer.destroy(); } catch { /* awareness cleanup quirk */ }
      try { providerClient.destroy(); } catch { /* awareness cleanup quirk */ }
    } finally {
      wss.close();
    }
  }, 30000);
});
