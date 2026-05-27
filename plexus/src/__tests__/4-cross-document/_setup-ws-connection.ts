// Vendored minimal y-websocket-server setupWSConnection for tests.
//
// Why: `@y/websocket-server@0.1.1` eagerly imports `y-leveldb` → `leveldown`
// at module load. `leveldown@5.6.0` has no prebuild for Node 24 (abi=127),
// so the import throws on platforms where rebuild fails. We never enable
// `YPERSISTENCE` or `CALLBACK_URL` here, so the leveldb + callback layers
// are dead weight.
//
// Source: github.com/yjs/y-websocket-server v0.1.1 src/utils.js, MIT licensed
// © Kevin Jahns, retained-attribution.

// eslint-disable-next-line import/no-unresolved
// eslint-disable-next-line import/no-unresolved

import type { IncomingMessage } from "node:http";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as map from "lib0/map";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

const messageSync = 0;
const messageAwareness = 1;

const docs = new Map<string, WSSharedDoc>();

class WSSharedDoc extends Y.Doc {
  readonly name: string;
  readonly conns = new Map<WebSocket, Set<number>>();
  readonly awareness: awarenessProtocol.Awareness;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        conn: WebSocket | null,
      ) => {
        const changedClients = added.concat(updated, removed);
        if (conn !== null) {
          const ids = this.conns.get(conn);
          if (ids !== undefined) {
            for (const id of added) ids.add(id);
            for (const id of removed) ids.delete(id);
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
        const buff = encoding.toUint8Array(encoder);
        for (const [c, _] of this.conns.entries()) send(this, c, buff);
      },
    );

    this.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const [conn, _] of this.conns.entries()) send(this, conn, message);
    });
  }
}

const getYDoc = (docname: string): WSSharedDoc =>
  map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname);
    docs.set(docname, doc);
    return doc;
  });

const closeConn = (doc: WSSharedDoc, conn: WebSocket) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)!;
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlledIds], null);
  }
  conn.close();
};

const send = (doc: WSSharedDoc, conn: WebSocket, m: Uint8Array) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(m, {}, (err) => err != null && closeConn(doc, conn));
  } catch {
    closeConn(doc, conn);
  }
};

const messageListener = (conn: WebSocket, doc: WSSharedDoc, message: Uint8Array) => {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
    }
  } catch (error) {
    console.error(error);
  }
};

const pingTimeout = 30_000;

export const setupWSConnection = (conn: WebSocket, req: IncomingMessage) => {
  conn.binaryType = "arraybuffer";
  const docName = (req.url ?? "").slice(1).split("?")[0];
  const doc = getYDoc(docName);
  doc.conns.set(conn, new Set());

  conn.on("message", (message: ArrayBuffer) => messageListener(conn, doc, new Uint8Array(message)));

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn);
      clearInterval(pingInterval);
    } else if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, pingTimeout);
  conn.on("close", () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });
  conn.on("pong", () => {
    pongReceived = true;
  });

  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageAwareness);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...awarenessStates.keys()]),
      );
      send(doc, conn, encoding.toUint8Array(enc));
    }
  }
};
