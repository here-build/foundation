/**
 * Plexus Awareness — multi-channel presence protocol.
 *
 * Forked from y-protocols/awareness. Same wire format, compatible with
 * existing providers (y-websocket, y-webrtc, etc.).
 *
 * Key difference: one user occupies MULTIPLE clientIds in the awareness map.
 * Channel 0 (base clientId) carries the schema — an ordered list of field names.
 * Channel N carries the value for field N. Each channel has its own clock and
 * updates independently.
 *
 * Only channel 0 heartbeats. Field channels sleep until their value changes.
 * When channel 0 times out, all channels for that user are cleaned up.
 *
 * Wire format (unchanged from y-protocols):
 *   varUint(numClients) + repeated { varUint(clientID) varUint(clock) varString(JSON(state)) }
 *
 * Channel clientId derivation:
 *   channel 0: baseClientId                        (schema + heartbeat)
 *   channel N: baseClientId + N   (field value)
 *
 * With 51-bit bases, two users differ by ~2^50 in expectation.
 * Stride of 1 is safe for any practical field count (< 256).
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as f from "lib0/function";
import * as math from "lib0/math";
import * as time from "lib0/time";
import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { deserialize, serialize } from "./awareness-serde.js";
import type { AwarenessShape } from "./proxy-runtime-types.js";
import { bucketCount, telemetry } from "./telemetry.js";

// ── Constants ────────────────────────────────────────────────────────

/** Stride between channels. Matches the 51-bit base width — parseChannelId uses modular arithmetic. */
const CHANNEL_STRIDE = 2 ** 51;

/** Peers not heard from in 30s are considered offline. */
export const outdatedTimeout = 30_000;

// ── Channel math ─────────────────────────────────────────────────────

/** Derive the awareness clientId for a given channel index. */
const channelId = (base: number, channel: number): number => base + channel * CHANNEL_STRIDE;

/** Extract base clientId and channel index from a raw awareness clientId. */
const parseChannelId = (raw: number): { base: number; channel: number } => ({
  base: raw % CHANNEL_STRIDE,
  channel: Math.floor(raw / CHANNEL_STRIDE),
});

// ── Types ────────────────────────────────────────────────────────────

interface MetaEntry {
  clock: number;
  lastUpdated: number;
}

type AwarenessEventData = {
  added: number[];
  updated: number[];
  removed: number[];
};

type AwarenessEvents = {
  destroy: (awareness: PlexusAwareness) => void;
  /** Fires on any accepted state change (including clock-only bumps). Providers listen to this. */
  update: (changes: AwarenessEventData, origin: any) => void;
  /** Fires only when state actually differs (deepEqual). UI listens to this. */
  change: (changes: AwarenessEventData, origin: any) => void;
};

// ── PlexusAwareness ──────────────────────────────────────────────────

export class PlexusAwareness<Shape extends AwarenessShape = AwarenessShape> extends Awareness {
  /** Schema: ordered field names. Channel 0 state = this array. */
  private readonly _schema: string[] = [];

  /** Field name → 1-based channel index. */
  private readonly _fieldIndex = new Map<string, number>();

  constructor(doc: Y.Doc) {
    super(doc);

    // Stop the parent class heartbeat — we manage our own
    clearInterval(this._checkInterval);

    // Initialize channel 0 with empty schema
    this._writeChannel(0, [], "local");

    // Heartbeat + stale cleanup
    this._checkInterval = setInterval(
      () => {
        const now = time.getUnixTime();

        // Heartbeat: re-broadcast channel 0 if stale (15s)
        const myMeta = this.meta.get(this.clientID);
        if (myMeta && this.states.has(this.clientID) && outdatedTimeout / 2 <= now - myMeta.lastUpdated) {
          this._writeChannel(0, [...this._schema], "local");
        }

        // Timeout: remove peers whose channel 0 is stale (30s)
        const toRemove: number[] = [];
        for (const [cid, meta] of this.meta.entries()) {
          if (cid === this.clientID) continue;
          const { channel } = parseChannelId(cid);
          if (channel !== 0) continue; // only check root channels
          if (outdatedTimeout <= now - meta.lastUpdated && this.states.has(cid)) {
            toRemove.push(cid);
          }
        }
        if (toRemove.length > 0) {
          for (const baseId of toRemove) this._removePeer(baseId, "timeout");
        }
      },
      math.floor(outdatedTimeout / 10),
    );

    doc.on("destroy", () => this.destroy());
  }

  override destroy(): void {
    this.emit("destroy", [this]);
    // Broadcast removal for all our channels
    const removed = this._removeLocalChannels();
    if (removed.length > 0) {
      this.emit("change", [{ added: [], updated: [], removed }, "local"]);
      this.emit("update", [{ added: [], updated: [], removed }, "local"]);
    }
    clearInterval(this._checkInterval);
    super.destroy();
  }

  // ── Local state ──────────────────────────────────────────────────

  /** Set a field value. Registers the field in the schema on first use.
   *  PlexusModel instances in the value are auto-serialized to reference markers. */
  setField<K extends string & keyof Shape>(field: K, value: Shape[K]): void {
    let idx = this._fieldIndex.get(field);
    if (idx === undefined) {
      // New field — append to schema
      idx = this._schema.length + 1; // 1-based channel index
      this._schema.push(field);
      this._fieldIndex.set(field, idx);
      // Update channel 0 (schema)
      this._writeChannel(0, [...this._schema], "local");
    }
    this._writeChannel(idx, serialize(value, this.doc), "local");
  }

  /** Clear a field value. The field stays in the schema (append-only). */
  clearField(field: string & keyof Shape): void {
    const idx = this._fieldIndex.get(field);
    if (idx === undefined) return;
    this._writeChannel(idx, null, "local");
  }

  /** Get a local field value. Entity reference markers are auto-deserialized to live PlexusModel instances. */
  getField<K extends string & keyof Shape>(field: K): Shape[K] | null | undefined {
    const idx = this._fieldIndex.get(field);
    if (idx === undefined) return undefined;
    const raw = this.states.get(channelId(this.clientID, idx));
    if (raw === undefined) return null; // cleared field → null (not undefined)
    if (raw === null) return null;
    return deserialize(raw, this.doc) as Shape[K];
  }

  /**
   * Merged local state with channel values left in their raw (un-deserialized)
   * wire form. Entity markers are NOT resolved. Use this when you need the
   * serialized shape (e.g. JSON dedup) without triggering entity proxies.
   */
  getRawLocalState(): Record<string, unknown> | null {
    if (!this.states.has(this.clientID)) return null;
    const result: Record<string, unknown> = {};
    for (const [name, idx] of this._fieldIndex) {
      const val = this.states.get(channelId(this.clientID, idx));
      if (val !== undefined && val !== null) result[name] = val;
    }
    return result;
  }

  /** Get all local field values as a plain object. Entity references are auto-deserialized. */
  override getLocalState(): Partial<Shape> | null {
    const raw = this.getRawLocalState();
    if (!raw) return null;
    const result: Record<string, any> = {};
    for (const [name, val] of Object.entries(raw)) result[name] = deserialize(val, this.doc);
    return result as Partial<Shape>;
  }

  /** Get the schema (field names in registration order). */
  getSchema(): readonly string[] {
    return this._schema;
  }

  // ── y-protocols compat shims ────────────────────────────────────

  /** Set all fields at once. Overrides y-protocols to use multi-channel protocol. */
  override setLocalState(state: Record<string, any> | null): void {
    if (state === null) {
      for (const field of this._schema) this.clearField(field as string & keyof Shape);
      return;
    }
    for (const [field, value] of Object.entries(state)) {
      this.setField(field as string & keyof Shape, value);
    }
  }

  /** Set a single field. Overrides y-protocols to use multi-channel protocol. */
  override setLocalStateField(field: string, value: any): void {
    this.setField(field as string & keyof Shape, value);
  }

  /** Return the raw states map. Overrides y-protocols. */
  override getStates(): Map<number, any> {
    return this.states;
  }

  // ── Peer state ───────────────────────────────────────────────────

  /**
   * Merged remote-peer state with channel values left in their raw
   * (un-deserialized) wire form. Entity markers are NOT resolved.
   */
  getRawPeer(baseClientId: number): Record<string, unknown> | null {
    const schema = this.states.get(baseClientId) as string[] | undefined;
    if (!schema || !Array.isArray(schema)) return null;
    const result: Record<string, unknown> = {};
    for (const [i, element] of schema.entries()) {
      const val = this.states.get(channelId(baseClientId, i + 1));
      if (val !== undefined && val !== null) result[element] = val;
    }
    return result;
  }

  /** Get merged state for a remote peer. Entity references are auto-deserialized. */
  getPeer(baseClientId: number): Partial<Shape> | null {
    const raw = this.getRawPeer(baseClientId);
    if (!raw) return null;
    const result: Record<string, any> = {};
    for (const [name, val] of Object.entries(raw)) result[name] = deserialize(val, this.doc);
    return result as Partial<Shape>;
  }

  /** Get all peer base clientIds (excludes self). */
  getPeerIds(): number[] {
    const peers: number[] = [];
    for (const cid of this.states.keys()) {
      const { base, channel } = parseChannelId(cid);
      if (channel === 0 && base !== this.clientID) {
        peers.push(base);
      }
    }
    return peers;
  }

  /** Iterate all peers as [baseClientId, mergedState] pairs. Entity references are auto-deserialized. */
  *peers(): Generator<[number, Partial<Shape>]> {
    for (const cid of this.states.keys()) {
      const { base, channel } = parseChannelId(cid);
      if (channel === 0 && base !== this.clientID) {
        const state = this.getPeer(base);
        if (state) yield [base, state];
      }
    }
  }

  // ── Internal ─────────────────────────────────────────────────────

  /** Write to a specific channel (local). */
  private _writeChannel(channelIndex: number, state: any, origin: any): void {
    const cid = channelId(this.clientID, channelIndex);
    const currMeta = this.meta.get(cid);
    // Start at 1 (not 0) so the first write is accepted by remote peers.
    // The y-protocols original starts at 0, which means clock-0 entries are
    // silently dropped by receivers (0 < 0 = false). In the original this
    // is mitigated by the user making a state change before the first sync,
    // but for multi-channel awareness we can't assume that — new fields may
    // be registered at any time.
    const clock = currMeta === undefined ? 1 : currMeta.clock + 1;
    const prevState = this.states.get(cid);

    if (state === null || state === undefined) {
      this.states.delete(cid);
    } else {
      this.states.set(cid, state);
    }
    this.meta.set(cid, { clock, lastUpdated: time.getUnixTime() });

    const added: number[] = [];
    const updated: number[] = [];
    const filteredUpdated: number[] = [];
    const removed: number[] = [];

    if (state == null) {
      if (prevState != null) removed.push(cid);
    } else if (prevState == null) {
      added.push(cid);
    } else {
      updated.push(cid);
      if (!f.equalityDeep(prevState, state)) filteredUpdated.push(cid);
    }

    if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
      this.emit("change", [{ added, updated: filteredUpdated, removed }, origin]);
    }
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.emit("update", [{ added, updated, removed }, origin]);
    }
  }

  /** Remove all channels for a remote peer. */
  private _removePeer(baseClientId: number, origin: any): void {
    const schema = this.states.get(baseClientId) as string[] | undefined;
    const removed: number[] = [];

    // Remove channel 0
    if (this.states.has(baseClientId)) {
      this.states.delete(baseClientId);
      removed.push(baseClientId);
    }

    // Remove all field channels
    if (schema && Array.isArray(schema)) {
      for (let i = 0; i < schema.length; i++) {
        const cid = channelId(baseClientId, i + 1);
        if (this.states.has(cid)) {
          this.states.delete(cid);
          removed.push(cid);
        }
      }
    }

    if (removed.length > 0) {
      this.emit("change", [{ added: [], updated: [], removed }, origin]);
      this.emit("update", [{ added: [], updated: [], removed }, origin]);
    }
  }

  /** Remove all local channels. Returns removed clientIds. */
  private _removeLocalChannels(): number[] {
    const removed: number[] = [];
    // Channel 0
    if (this.states.has(this.clientID)) {
      this.states.delete(this.clientID);
      const meta = this.meta.get(this.clientID);
      this.meta.set(this.clientID, { clock: (meta?.clock ?? 0) + 1, lastUpdated: time.getUnixTime() });
      removed.push(this.clientID);
    }
    // Field channels
    for (let i = 0; i < this._schema.length; i++) {
      const cid = channelId(this.clientID, i + 1);
      if (this.states.has(cid)) {
        this.states.delete(cid);
        const meta = this.meta.get(cid);
        this.meta.set(cid, { clock: (meta?.clock ?? 0) + 1, lastUpdated: time.getUnixTime() });
        removed.push(cid);
      }
    }
    return removed;
  }
}

// ── Protocol functions (forked from y-protocols, wire-compatible) ───

/**
 * Encode awareness update for specific clients.
 * Wire format: varUint(len) + repeated { varUint(clientID) varUint(clock) varString(JSON(state)) }
 */
export const encodeAwarenessUpdate = (
  awareness: PlexusAwareness,
  clients: number[],
  states: Map<number, any> = awareness.states,
): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clients.length);
  for (const clientID of clients) {
    const state = states.get(clientID) || null;
    const meta = awareness.meta.get(clientID);
    encoding.writeVarUint(encoder, clientID);
    encoding.writeVarUint(encoder, meta?.clock ?? 0);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  const bytes = encoding.toUint8Array(encoder);
  if (telemetry.enabled) {
    // CRDT-cohort canonical signal: >4KB awareness frame almost always
    // means someone stuffed a Y.Doc snapshot into a presence field.
    // Histogram lets dashboards alert on tail growth without sampling.
    telemetry.histogram("plexus.awareness.update_bytes", bytes.byteLength, {
      direction: "encode",
      client_count: bucketCount(clients.length),
    });
  }
  return bytes;
};

/**
 * Apply a remote awareness update. Accepts entries with newer clocks.
 * Null state = client removed. Self-protection: refuses removal of own clientId.
 */
export const applyAwarenessUpdate = (awareness: PlexusAwareness, update: Uint8Array, origin: any): void => {
  if (telemetry.enabled) {
    telemetry.histogram("plexus.awareness.update_bytes", update.byteLength, { direction: "apply" });
  }
  const decoder = decoding.createDecoder(update);
  const timestamp = time.getUnixTime();
  const added: number[] = [];
  const updated: number[] = [];
  const filteredUpdated: number[] = [];
  const removed: number[] = [];
  const len = decoding.readVarUint(decoder);

  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder);
    let clock = decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));

    const clientMeta = awareness.meta.get(clientID);
    const prevState = awareness.states.get(clientID);
    const currClock = clientMeta === undefined ? 0 : clientMeta.clock;

    if (currClock < clock || (currClock === clock && state === null && awareness.states.has(clientID))) {
      if (state === null) {
        // Self-protection: refuse removal of any of our own channels
        const { base } = parseChannelId(clientID);
        if (base === awareness.clientID && awareness.states.has(clientID)) {
          clock++;
        } else {
          awareness.states.delete(clientID);
        }
      } else {
        awareness.states.set(clientID, state);
      }

      awareness.meta.set(clientID, { clock, lastUpdated: timestamp });

      if (clientMeta === undefined && state !== null) {
        added.push(clientID);
      } else if (clientMeta !== undefined && state === null) {
        removed.push(clientID);
      } else if (state !== null) {
        if (!f.equalityDeep(state, prevState)) {
          filteredUpdated.push(clientID);
        }
        updated.push(clientID);
      }
    }
  }

  if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
    awareness.emit("change", [{ added, updated: filteredUpdated, removed }, origin]);
  }
  if (added.length > 0 || updated.length > 0 || removed.length > 0) {
    awareness.emit("update", [{ added, updated, removed }, origin]);
  }
};

/**
 * Remove awareness states for specific clients.
 * Used for explicit disconnection or server-side cleanup.
 */
export const removeAwarenessStates = (awareness: PlexusAwareness, clients: number[], origin: any): void => {
  const removed: number[] = [];
  for (const clientID of clients) {
    if (awareness.states.has(clientID)) {
      awareness.states.delete(clientID);
      if (parseChannelId(clientID).base === awareness.clientID) {
        const curMeta = awareness.meta.get(clientID);
        awareness.meta.set(clientID, { clock: (curMeta?.clock ?? 0) + 1, lastUpdated: time.getUnixTime() });
      }
      removed.push(clientID);
    }
  }
  if (removed.length > 0) {
    awareness.emit("change", [{ added: [], updated: [], removed }, origin]);
    awareness.emit("update", [{ added: [], updated: [], removed }, origin]);
  }
};

/**
 * Decode and re-encode an awareness update with a transform function.
 * Useful for server-side validation/sanitization.
 */
export const modifyAwarenessUpdate = (update: Uint8Array, modify: (state: any) => any): Uint8Array => {
  const decoder = decoding.createDecoder(update);
  const encoder = encoding.createEncoder();
  const len = decoding.readVarUint(decoder);
  encoding.writeVarUint(encoder, len);
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    encoding.writeVarUint(encoder, clientID);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(modify(state)));
  }
  return encoding.toUint8Array(encoder);
};
