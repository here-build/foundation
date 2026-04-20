import * as encoding from "lib0/encoding";
import * as Y from "yjs";

/**
 * Build a state vector that excludes a specific client.
 * When used with encodeStateAsUpdate, this produces only the target client's Items.
 */
export const getSelectiveStateVector = (doc: Y.Doc, targetClient = doc.clientID) => {
  const store = doc.store;
  const sm = new Map<number, number>();
  store.clients.forEach((structs, client) => {
    if (client === targetClient) return;
    const struct = structs.at(-1)!;
    sm.set(client, struct.id.clock + struct.length);
  });
  return sm;
};

/**
 * Encode only the Items belonging to a specific client.
 */
export const getIndividualVector = (doc: Y.Doc, targetClient = doc.clientID) =>
  Y.encodeStateAsUpdate(doc, Y.encodeStateVector(getSelectiveStateVector(doc, targetClient)));

/**
 * Build a delete-set-only Yjs update that marks all Items under the given
 * clientId as deleted. No structs — just the delete set.
 *
 * When applied to a doc that has these Items, they get deleted and the
 * Y.Map/XmlElement attributes revert to their previous non-deleted values.
 * When applied to a doc that doesn't have them, it's a no-op.
 */
export function buildDeleteSetUpdate(doc: Y.Doc, clientId: number, startClock = 0, length?: number): Uint8Array {
  const clients = doc.store.clients as Map<number, any[]>;
  const structs = clients.get(clientId);
  if (!structs?.length) return new Uint8Array([0, 0]);

  const last = structs.at(-1)!;
  const totalLen = length ?? last.id.clock + last.length - startClock;
  if (totalLen <= 0) return new Uint8Array([0, 0]);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0); // 0 structs
  encoding.writeVarUint(encoder, 1); // 1 delete-set client
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, 1); // 1 range
  encoding.writeVarUint(encoder, startClock);
  encoding.writeVarUint(encoder, totalLen);
  return encoding.toUint8Array(encoder);
}

/** Get the max clock for a clientId in a doc's struct store (0 if absent). */
export function getMaxClock(doc: Y.Doc, clientId: number): number {
  const structs = (doc.store.clients as Map<number, any[]>).get(clientId);
  if (!structs?.length) return 0;
  const last = structs.at(-1)!;
  return last.id.clock + last.length;
}

/**
 * Temporarily rewrite all Items under `fromId` to `toId` in the doc's struct store,
 * execute a callback, then restore. The callback sees the store with rewritten IDs.
 *
 * Rewrites: item.id, item.origin (if referencing fromId), item.rightOrigin (if referencing fromId).
 * Also swaps the clients Map key: clients.delete(fromId) → clients.set(toId, structs).
 *
 * Returns the callback's return value. Restoration happens in a finally block.
 */
export function withRewrittenClientId<T>(doc: Y.Doc, fromId: number, toId: number, fn: () => T): T {
  const clients = (doc.store as any).clients as Map<number, any[]>;
  const structs = clients.get(fromId);
  if (!structs?.length) return fn();

  // Rewrite: fromId → toId
  clients.delete(fromId);
  clients.set(toId, structs);
  const saved: Array<{ id: any; origin: any; rightOrigin: any }> = [];
  for (const s of structs) {
    saved.push({ id: s.id, origin: s.origin, rightOrigin: s.rightOrigin });
    s.id = new Y.ID(toId, s.id.clock);
    if (s.origin?.client === fromId) s.origin = new Y.ID(toId, s.origin.clock);
    if (s.rightOrigin?.client === fromId) s.rightOrigin = new Y.ID(toId, s.rightOrigin.clock);
  }

  try {
    return fn();
  } finally {
    // Restore: toId → fromId
    for (let i = 0; i < structs.length; i++) {
      structs[i].id = saved[i].id;
      structs[i].origin = saved[i].origin;
      structs[i].rightOrigin = saved[i].rightOrigin;
    }
    clients.delete(toId);
    clients.set(fromId, structs);
  }
}

/**
 * Extract committed delta from shadow doc via clientId rewrite.
 *
 * Temporarily rewrites liminal Items (id + origin + rightOrigin) to the
 * committed-liminal namespace, encodes a delta against main's state vector,
 * then restores. The result is merged with a delete set for the original
 * liminal clientId — so peers who applied the preview automatically clean
 * up the preview Items when the committed delta arrives via sync.
 *
 * IMPORTANT: The shadow doc must use a FRESH clientId per liminal session
 * (assigned in enterLiminality). This ensures only liminal Items are under
 * limId — prior normal writes use a different clientId and are untouched.
 */
export function extractCommittedDelta(shadow: Y.Doc, main: Y.Doc, limId: number, liminalBase: number): Uint8Array {
  const committedId = limId + liminalBase;
  const clients = (shadow.store as any).clients as Map<number, any[]>;
  const structs = clients.get(limId);

  // Pure deletes (no limId structs): encode the delete set diff directly.
  // Array splice etc. don't create Items under limId but DO mark existing Items deleted.
  if (!structs?.length) {
    return Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(main));
  }

  // 1. Build delete set for limId BEFORE rewrite (structs still under limId).
  // Cleans up preview Items on peers. On main this is a no-op.
  const previewCleanup = buildDeleteSetUpdate(shadow, limId);

  // 2. Rewrite limId → committedId, encode against main's SV, restore.
  const commitDelta = withRewrittenClientId(shadow, limId, committedId, () =>
    Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(main)),
  );

  // 3. Merge: committedId structs + limId delete set = one compound update
  return Y.mergeUpdates([commitDelta, previewCleanup]);
}
