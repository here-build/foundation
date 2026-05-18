/**
 * Plexus Document — shadow-primary CRDT orchestration.
 *
 * Architecture: two Y.Docs per Plexus instance.
 * - **Shadow doc** — the working copy. All entities bind here. Reads and writes go through shadow.
 * - **Main doc** — the committed store. Syncs to peers. Receives forwarded writes from shadow.
 *
 * Origin-based routing controls what flows between docs:
 * - SHADOW_TO_MAIN: normal entity writes → forwarded to main (UndoManager tracks)
 * - LIMINAL: drag/scrub writes → held on shadow (not forwarded)
 * - COMMIT_DELTA: committed liminality → applied to main, forwarded to shadow
 * - FROM_SHADOW/FROM_MAIN: echo prevention markers
 *
 * Liminality commit sequence (6 invariants, all required):
 * 1. Fresh monotonic clientId per session (isolates liminal Items from prior writes)
 * 2. ClientId rewrite → encode delta (action reproduction under committed namespace)
 * 3. Apply to main FIRST (forwarding propagates to shadow while scaffolding is intact)
 * 4. Undo liminal Items on shadow (scaffolding removal — committed Items survive)
 * 5. Fresh clientId after commit (prevents clock gap on main)
 * 6. Block liminal UndoManager's origin from shadow→main forwarding (undo doesn't clobber main)
 */

import { fromBase64, toBase64 } from "lib0/buffer";
import * as time from "lib0/time";
import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { ReadonlyDeep } from "type-fest";
import * as Y from "yjs";
import { UndoManager } from "yjs";

import { PlexusAwareness } from "./awareness.js";
import { createBlobFromDoc, decodeBlob, type DecodedBlob } from "./dependency-blob.js";
import { deref } from "./deref.js";
import { documentEntityCaches } from "./entity-cache.js";
import { declareDeterministicMap, isGenesisClientId, LIMINAL_BASE, newClientId } from "./genesis-client.js";
import { entityClasses } from "./globals.js";
import { docLiminality, docPlexus, docTransactionOrigin } from "./plexus-registry.js";
import { getInternals, type PlexusConstructor, PlexusModel } from "./PlexusModel.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import { ORIGIN_KIND, type OriginKindLabel, telemetry, type TelemetrySpan } from "./telemetry.js";
import { GENESIS_ORIGIN } from "./virtual-children-genesis.js";
import type { AllowedYValue, AwarenessShape, PlexusUUID, YPlexusNode } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { maybeTransacting } from "./utils/utils.js";
import { buildDeleteSetUpdate, extractCommittedDelta, getMaxClock } from "./utils/yjs-algebra.js";
import { getDependenciesMap, getMetaMap, getModelTypesMap } from "./yjs/getModels.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";

/** Collective TTL for liminal sessions (seconds). All clients independently
 *  drop a peer's preview after this duration from startSec. Deterministic. */
const LIMINAL_SESSION_TTL = 5 * 60; // 5 minutes

// ── Origin Constants ─────────────────────────────────────────────────

/** Normal Plexus write on shadow → forwarded to main (UndoManager tracks this). */
const SHADOW_TO_MAIN = Symbol("shadow→main");

/** Liminal write on shadow → NOT forwarded to main. */
const LIMINAL_ORIGIN = Symbol("liminal");

/** Committed delta applied to main + forwarded to shadow. */
const COMMIT_DELTA_ORIGIN = Symbol("commit-delta");

/** Shadow update forwarded to main without UndoManager tracking (genesis, lazy containers). */
const FROM_SHADOW = Symbol("from-shadow");

/** Main update forwarded to shadow (prevents echo back). */
const FROM_MAIN = Symbol("from-main");

/**
 * Map a Yjs transaction origin to its low-cardinality `origin_kind`
 * telemetry label. Plexus's local symbols are module-private; this
 * helper crosses the boundary and exposes a stable categorical label
 * for metric attributes. Per-instance `UndoManager` origins collapse
 * to a single `undo_manager` label.
 */
function originKindOf(origin: unknown): OriginKindLabel {
  if (origin === SHADOW_TO_MAIN) return ORIGIN_KIND.SHADOW_TO_MAIN;
  if (origin === FROM_SHADOW) return ORIGIN_KIND.FROM_SHADOW;
  if (origin === FROM_MAIN) return ORIGIN_KIND.FROM_MAIN;
  if (origin === LIMINAL_ORIGIN) return ORIGIN_KIND.LIMINAL;
  if (origin === COMMIT_DELTA_ORIGIN) return ORIGIN_KIND.COMMIT_DELTA;
  if (origin === GENESIS_ORIGIN) return ORIGIN_KIND.GENESIS;
  if (origin instanceof UndoManager) return ORIGIN_KIND.UNDO_MANAGER;
  return ORIGIN_KIND.EXTERNAL;
}

export class Plexus<
  Root extends PlexusModel<null> & { dependencies?: Record<string, Root> },
  Awareness extends AwarenessShape = AwarenessShape,
> {
  /** Enable PLEXUS_TEST_SENTINEL — constructor throws the sentinel symbol for reachability testing. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  public static testSentinels: boolean = false;

  /** Set during controlled construction (sentinel-driven). Read by decorators init() to skip field initialization. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  static __isControlledConstruction__: boolean = false;

  /** Override in tests for deterministic UUIDs. Only used when PLEXUS_UUID_MODE=arbitrary. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  public static uuidMode: "arbitrary" | undefined = (() => {
    try {
      return process.env.PLEXUS_UUID_MODE as "arbitrary" | undefined;
    } catch {
      return;
    }
  })();
  // eslint-disable-next-line sonarjs/public-static-readonly
  public static getArbitraryUUID: () => string = nanoid;
  readonly rootDependenciesRepresentation: ReadonlyDeep<Record<string, Root>> = new Proxy(
    {},
    {
      ownKeys: () => [...this.yDependencies.keys()],
      get: (_, key: string) => {
        if (typeof key !== "string") return;
        const blob = this.yDependencies.get(key);
        if (!blob) return;
        const decoded = this.#decodedBlobs.get(key);
        if (!decoded) return;
        return this.#materializeDependencyEntity(key, decoded.rootUuid);
      },
      getOwnPropertyDescriptor: (_, key: string) => {
        if (typeof key !== "string" || !this.yDependencies.has(key)) return;
        return { configurable: true, enumerable: true, value: this.rootDependenciesRepresentation[key] };
      },
    },
  );
  protected readonly yDependencies: Y.Map<Uint8Array>;

  readonly #decodedBlobs = new Map<string, DecodedBlob>();
  readonly #dependencyEntityCache = new Map<string, PlexusModel>();

  #ensureDecoded(projectId: string): DecodedBlob {
    let decoded = this.#decodedBlobs.get(projectId);
    if (!decoded) {
      const blob = this.yDependencies.get(projectId);
      invariant(blob, `Plexus: dependency "${projectId}" not loaded`);
      decoded = decodeBlob(blob);
      this.#decodedBlobs.set(projectId, decoded);
    }
    return decoded;
  }

  #materializeDependencyEntity(projectId: string, entityUuid: string): PlexusModel {
    const cacheKey = `${projectId}\0${entityUuid}`;
    const cached = this.#dependencyEntityCache.get(cacheKey);
    if (cached) return cached;

    const decoded = this.#ensureDecoded(projectId);
    const entry = decoded.entities.get(entityUuid);
    invariant(entry, `Plexus: entity "${entityUuid}" not found in dependency "${projectId}"`);

    const constructor = entityClasses.get(entry.type);
    invariant(
      constructor,
      `Plexus<dep#${projectId}, model#${entityUuid}> cannot discover model constructor "${entry.type}"`,
    );

    const self = this;
    const model = PlexusModel.__materializePredefined__(
      constructor as Extract<typeof constructor, new (...args: any) => any>,
      {
        isDependency: true,
        documentId: entry.sourceProjectId ?? projectId,
        uuid: entityUuid as PlexusUUID,
        get parent() {
          return entry.parentUuid ? self.#materializeDependencyEntity(projectId, entry.parentUuid) : null;
        },
        reference: [entityUuid, entry.sourceProjectId ?? projectId],
        parentKey: null,
        parentMetadata: null,
      },
    );

    // Lazy field hydration with deref for cross-doc reference resolution
    const fieldCache: Record<string, unknown> = {};
    const resolveProjectId = entry.sourceProjectId ?? projectId;
    Object.defineProperties(
      model,
      Object.fromEntries(
        Object.entries(model.__schema__).map(([key, type]): [string, PropertyDescriptor] => {
          const value = entry.attributes[key];
          switch (type) {
            case "val":
            case "child-val":
              return [
                key,
                {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    fieldCache[key] ??=
                      value == null ? null : deref(this.doc, value as AllowedYValue, resolveProjectId);
                    return fieldCache[key];
                  },
                },
              ];
            case "list":
            case "child-list":
              return [
                key,
                {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    fieldCache[key] ??= value
                      ? (value as AllowedYValue[]).map((v) => deref(this.doc, v, resolveProjectId))
                      : [];
                    return fieldCache[key];
                  },
                },
              ];
            case "set":
            case "child-set":
              return [
                key,
                {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    fieldCache[key] ??= value
                      ? new Set((value as AllowedYValue[]).map((v) => deref(this.doc, v, resolveProjectId)))
                      : new Set();
                    return fieldCache[key];
                  },
                },
              ];
            case "record":
            case "child-record":
              return [
                key,
                {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    fieldCache[key] ??= value
                      ? Object.fromEntries(
                          Object.entries(value as Record<string, AllowedYValue>).map(([k, v]) => [
                            k,
                            deref(this.doc, v, resolveProjectId),
                          ]),
                        )
                      : {};
                    return fieldCache[key];
                  },
                },
              ];
            case "map":
            case "child-map":
              return [
                key,
                {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    fieldCache[key] ??= value
                      ? new Map(
                          Object.entries(value as Record<string, AllowedYValue>).map(([k, v]) => [
                            k,
                            deref(this.doc, v, resolveProjectId),
                          ]),
                        )
                      : new Map();
                    return fieldCache[key];
                  },
                },
              ];
          }
        }),
      ),
    );

    this.#dependencyEntityCache.set(cacheKey, model);
    return model;
  }

  protected readonly yTypes: Y.Map<Y.Map<YPlexusNode>>;
  private readonly __undoManager__: UndoManager;
  private __isUndoing__ = false;

  /** Multi-channel awareness — owned by Plexus, exposed for providers and user state.
   *  The Awareness type parameter provides type-safe field access. */
  readonly awareness!: PlexusAwareness<Awareness>;

  /** Shadow doc. gc:false — origin chains must survive for committed delta integration. */
  private readonly __liminalDocument__ = new Y.Doc({ gc: false });
  private readonly __liminalUndoManager__!: UndoManager;
  private __liminalHeight__ = 0;

  // noinspection JSUnusedLocalSymbols
  protected constructor(
    public readonly doc: Y.Doc,
    public readonly root: Root,
  ) {
    invariant(!docPlexus.has(doc), `Plexus<document#${doc.clientID}>: already initialized, singleton violation`);
    docPlexus.set(doc, this);

    const shadow = this.__liminalDocument__;

    // Overwrite doc clientId with 51-bit random. All derived clientIds flow from this:
    // liminal = X + LIMINAL_BASE, committed = limId + 2^51, genesis = independent hash.
    doc.clientID = newClientId();
    shadow.clientID = doc.clientID + LIMINAL_BASE;

    // Initial sync: main → shadow (full state)
    Y.applyUpdate(shadow, Y.encodeStateAsUpdate(doc));

    // Shadow → Main: forward everything except liminal, echoes, and undo scaffolding removal.
    // SHADOW_TO_MAIN preserves origin (main UM captures). Everything else becomes FROM_SHADOW.
    shadow.on("update", (update: Uint8Array, origin: any) => {
      if (telemetry.enabled) {
        const originKind = originKindOf(origin);
        telemetry.counter("plexus.crdt.shadow_update", { origin_kind: originKind });
        telemetry.histogram("plexus.crdt.shadow_update_bytes", update.byteLength, { origin_kind: originKind });
      }
      if (origin === LIMINAL_ORIGIN) return;
      if (origin === FROM_MAIN) return;
      if (origin === this.__liminalUndoManager__) return;
      // Block per-peer preview origins and their UM undo artifacts.
      // GENESIS_ORIGIN is a plexus-internal origin that writes the virtual-map
      // key→ref epilogue (see virtual-children-genesis.ts line 327-329); it must
      // forward to main or the clock advance on shadow creates a pending-struct
      // gap that silently drops subsequent writes on hydration.
      if (
        typeof origin === "symbol" &&
        origin !== SHADOW_TO_MAIN &&
        origin !== COMMIT_DELTA_ORIGIN &&
        origin !== FROM_SHADOW &&
        origin !== GENESIS_ORIGIN
      )
        return;
      if (origin instanceof UndoManager && origin !== this.__undoManager__) return;
      Y.applyUpdate(doc, update, origin === SHADOW_TO_MAIN ? SHADOW_TO_MAIN : FROM_SHADOW);
    });

    // Main → Shadow: forward everything except echoes.
    doc.on("update", (update: Uint8Array, origin: any) => {
      if (telemetry.enabled) {
        const originKind = originKindOf(origin);
        telemetry.counter("plexus.crdt.main_update", { origin_kind: originKind });
        telemetry.histogram("plexus.crdt.main_update_bytes", update.byteLength, { origin_kind: originKind });
      }
      if (origin === SHADOW_TO_MAIN || origin === FROM_SHADOW) return;
      Y.applyUpdate(shadow, update, FROM_MAIN);
    });

    docPlexus.set(shadow, this);
    docTransactionOrigin.set(shadow, SHADOW_TO_MAIN);

    this.yTypes = getModelTypesMap(doc);
    this.yDependencies = getDependenciesMap(doc);

    // Genesis scaffold on main (forwarded to shadow). Must precede UndoManager — undo should
    // only remove entities, not the type sub-maps that hold them.
    for (const type of entityClasses.keys()) {
      declareDeterministicMap(doc, [YJS_GLOBALS.types.key, type]);
    }

    // Root materialization on shadow. connect() passes UUID string; bootstrap() passes entity.
    if (typeof root === "string") {
      root = deref(shadow, [root]) as Root;
      getInternals(root).isRoot = true;
    } else {
      const rootInternals = getInternals(root);
      rootInternals.isRoot = true;
      root[referenceSymbol](shadow);
    }
    (this as { root: Root }).root = root;

    // Root pointer on main (for remote peer discovery). After materialization — UUID is assigned there.
    getMetaMap(doc).set(YJS_GLOBALS.meta.wellKnown.root, getInternals(root).uuid!);

    // Main UndoManager. ignoreRemoteMapChanges: committed deltas use different clientIds per session —
    // without it, redoItem's conflict detection treats successive commits as "remote" and refuses undo.
    //
    // deleteFilter implements append-only entity shells:
    // - Entity XmlElements in type sub-maps are never deleted (identity preservation)
    // - Initial field values (created during materialization) are never deleted (floor state)
    // - Post-materialization field writes ARE deleted (normal undo behavior)
    //
    // The filter discovers materialization boundaries dynamically: when it encounters
    // an XmlElement Item in a typeMap, it records the clock. Items inside that XmlElement
    // with clock ≤ materialization clock are protected (creation state).
    //
    // Load-bearing invariant: parent containers (Y.Array for child-list, Y.Map for
    // child-map) hold UUID string tuples (ReferenceTuple), NOT embedded XmlElements.
    // XmlElements live exclusively in typeMap sub-maps and are referenced by UUID
    // elsewhere. This is why "content is at most 2 levels deep" holds — there is no
    // nested XmlElement inside a container for the filter to miss, only string-tuple
    // references that are safe to revert via redo. Do not "simplify" the 2-level
    // walk without revalidating this invariant first.
    //
    // Structural check: is a Y.Map a type sub-map of yTypes?
    // Type sub-maps are created via virtual genesis — permanent, never in undo cycle.
    const yTypesRef = this.yTypes;
    const isTypeSubMap = (parent: Y.AbstractType<any> | null): boolean => parent?.parent === yTypesRef;

    const entityCaches = documentEntityCaches;
    const shadowDoc = shadow;
    this.__undoManager__ = new UndoManager(this.yTypes, {
      captureTimeout: 500,
      trackedOrigins: new Set([SHADOW_TO_MAIN, COMMIT_DELTA_ORIGIN]),
      ignoreRemoteMapChanges: true,
      deleteFilter: (item) => {
        const parent = item.parent;
        // Item.parent is AbstractType | ID | null — only AbstractType has structural meaning here
        if (!(parent instanceof Y.AbstractType)) return true;

        // 1. Entity shell in type sub-map → PROTECT (never delete entity identity)
        if (isTypeSubMap(parent) && item.parentSub !== null) {
          return false;
        }

        // 2. Creation content inside a protected XmlElement → PROTECT
        //    Entity content is at most 2 levels deep:
        //    Level 1: parent IS the XmlElement (attributes)
        //    Level 2: parent is a Y.Map/Y.Array whose .parent is the XmlElement (containers)
        const xmlEl: Y.XmlElement | null =
          parent instanceof Y.XmlElement ? parent : parent.parent instanceof Y.XmlElement ? parent.parent : null;

        if (xmlEl && isTypeSubMap(xmlEl.parent)) {
          // _item.parentSub is the UUID (map key) — no public API for this
          const uuid: string | null = (xmlEl as unknown as { _item?: { parentSub: string | null } })._item?.parentSub ?? null;
          if (uuid) {
            const model = entityCaches.get(shadowDoc).get(uuid)?.deref();
            if (model) {
              const internals = getInternals(model);
              if (
                !internals.isDependency &&
                internals.materializationClock !== undefined &&
                internals.materializationClient !== undefined &&
                item.id.client === internals.materializationClient &&
                item.id.clock < internals.materializationClock
              ) {
                return false; // creation content — protected
              }
            }
          }
        }

        return true;
      },
    });

    // Liminal UndoManager — tracks only LIMINAL writes on shadow. captureTimeout:0 = no batching.
    this.__liminalUndoManager__ = new UndoManager(getModelTypesMap(shadow), {
      trackedOrigins: new Set([LIMINAL_ORIGIN]),
      captureTimeout: 0,
    });

    this.awareness = new PlexusAwareness(doc);

    // Auto-process peer liminal previews on awareness changes.
    // Collective TTL: all clients independently drop a session after LIMINAL_SESSION_TTL
    // seconds from startSec. Deterministic — no coordination needed.
    this.awareness.on("change", () => {
      const nowSec = Math.floor(time.getUnixTime() / 1000);
      for (const peerId of this.awareness.getPeerIds()) {
        const peer = this.awareness.getPeer(peerId);
        const liminal = peer?.liminal as [number, number, string] | null | undefined;
        // TTL check: expired sessions are treated as null (collective drop)
        if (liminal && nowSec - liminal[1] > LIMINAL_SESSION_TTL) {
          this.applyPeerPreview(peerId, null);
        } else {
          this.applyPeerPreview(peerId, liminal ?? null);
        }
      }
      for (const peerId of this.__peerPreviews__.keys()) {
        if (!this.awareness.getPeerIds().includes(peerId)) {
          this.applyPeerPreview(peerId, null);
        }
      }
    });

    // Abort liminal session on background tab — prevents stale preview state.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && this.isLiminal) this.revertLiminality();
      });
    }

    // Strip genesis Items from UndoManager StackItems.
    // Genesis clientIds live in the 0x1F namespace (>= GENESIS_BASE = 31 × 2^40).
    // Liminal clientIds (0x01 namespace, [2^32, 2^33)) are NOT stripped — committed
    // liminal changes are user decisions that must survive undo/redo.
    this.__undoManager__.on("stack-item-added", (event) => {
      const clients = event.stackItem.insertions.clients;
      for (const clientId of clients.keys()) {
        if (isGenesisClientId(clientId)) {
          clients.delete(clientId);
        }
      }
    });

    // Wire up undo/redo notification bridge
    const handler = this.__undoManager__.on("stack-item-popped", (event) => {
      if (!this.__isUndoing__) {
        return;
      }
      const notifiedTargets = new Set<PlexusModel | Y.AbstractType<any>>();
      for (const yEvents of event.changedParentTypes.values()) {
        // we have very specific issue here: when we're undo-ing the changeset that was including model materialization,
        // we have it deleted, too, leading to funky state.
        for (const evt of yEvents) {
          // Skip outer types map events (type sub-map added/removed)
          if (evt.target === this.yTypes) {
            continue;
          }
          // Type sub-map event — entity added/deleted within a type
          if (evt.target instanceof Y.Map && evt.target !== this.yTypes) {
            for (const [id, change] of evt.changes.keys.entries()) {
              const model = documentEntityCaches.get(shadow).get(id)?.deref();
              if (!model) continue; // Entity may not be cached yet (e.g. from remote peer)
              const internals = getInternals(model);
              if (internals.isDependency) {
                continue; // very likely we should not do anything; yet, this assumption is not 100%
              }

              if (notifiedTargets.has(model)) {
                continue;
              }
              notifiedTargets.add(model);

              if (change.action === "add") {
                const newElement = (evt.target as Y.Map<YPlexusNode>).get(id)!;
                if (internals.yjsModel?.element !== newElement) {
                  // Entity re-appeared (e.g. peer sync). Re-wrap and re-observe.
                  internals.yjsModel = new PlexusWrapper(newElement);
                  model.__bootstrapObservation__();
                  undoManagerNotifications.get(newElement)?.({
                    attributesChanged: new Set([...Object.keys(model.__schema__), PlexusWrapper.PARENT_ATTR]),
                  });
                }
                continue;
              }
              if (change.action === "delete") {
                // With append-only shells + deleteFilter, this should rarely fire for
                // local entities. May still occur for edge cases (external GC, dependency cleanup).
                // Entity becomes detached but stays readable — no field deletion.
                internals.unobserve?.();
                internals.yjsModel = undefined;
              }
              // todo we may need to process "update" too
            }
            continue;
          }
          // Forward events to the target's notification handler
          const target = evt.target;

          if (!notifiedTargets.has(target)) {
            notifiedTargets.add(target);
            undoManagerNotifications.get(target)?.(evt);
          }
        }
      }
    });
    this.__undoManager__.on("stack-item-added", handler);
  }

  /**
   * Connect to an existing Y.Doc that already has a root.
   * Returns existing instance if one exists for this class, otherwise creates new.
   * Doc must be synced before calling - if no root found, throws with helpful hint.
   */

  static connect(doc: Y.Doc) {
    invariant(doc instanceof Y.Doc, "Plexus.connect: doc is not from Plexus's yjs (duplicate yjs module in node_modules)");
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc);
    if (existing) {
      invariant(
        existing.constructor === this,
        `Plexus<document#${doc.clientID}>.connect: already bound to ${existing.constructor.name}`,
      );
      return existing;
    }

    const meta = getMetaMap(doc);
    const rootUuid = meta.get(YJS_GLOBALS.meta.wellKnown.root);

    invariant(rootUuid, `Plexus<document#${doc.clientID}>.connect: no root found, await sync first`);

    return new this(doc, rootUuid as any);
  }

  /**
   * Get all materialized instances of a given model type.
   * Uses the types/{type} sub-map directly — no separate type index needed.
   */
  getAllOfType<T extends PlexusModel>(constructor: PlexusConstructor<T>): T[] {
    const typeMap = getModelTypesMap(this.__liminalDocument__).get(constructor.modelName);
    if (!typeMap) return [];
    return [...typeMap.keys()].map((uuid) => deref(this.__liminalDocument__, [uuid]) as T);
  }

  /**
   * Bootstrap a new Y.Doc with the provided root entity.
   * Returns existing instance if one exists for this class.
   */
  static bootstrap(root: PlexusModel, documentId: string = nanoid(), doc: Y.Doc = new Y.Doc({ guid: documentId })) {
    invariant(doc instanceof Y.Doc, "Plexus.bootstrap: doc is not from Plexus's yjs (duplicate yjs module in node_modules)");
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc);
    if (existing) {
      invariant(
        existing.constructor === this,
        `Plexus<document#${doc.clientID}>.bootstrap: already bound to ${existing.constructor.name}`,
      );
      return existing;
    }
    return new this(doc, root);
  }

  undo() {
    // Undo during liminality: revert the liminal session first, then undo on prime
    if (this.isLiminal) this.revertLiminality();

    if (this.__isUndoing__) {
      this.__undoManager__.undo();
    } else {
      this.__isUndoing__ = true;
      this.__undoManager__.undo();
      this.__isUndoing__ = false;
    }
  }

  redo() {
    // Redo during liminality: revert the liminal session first, then redo on prime
    if (this.isLiminal) this.revertLiminality();

    if (this.__isUndoing__) {
      this.__undoManager__.redo();
    } else {
      this.__isUndoing__ = true;
      this.__undoManager__.redo();
      this.__isUndoing__ = false;
    }
  }

  stopCapturing() {
    if (this.isLiminal) {
      this.__liminalUndoManager__.stopCapturing();
    } else {
      this.__undoManager__.stopCapturing();
    }
  }

  /**
   * Load an entity by ID. Resolves from shadow doc (where entities live).
   */
  loadEntity<T extends PlexusModel>(entityId: string): T | null {
    return deref(this.__liminalDocument__, [entityId]) as T | null;
  }

  /**
   * Execute a function within a transaction.
   * Uses maybeTransacting which handles:
   * - YJS transaction wrapping
   * - Shadow sub-transactions (no-op for nested calls)
   * - Notification batching and flushing
   */
  transact<T>(fn: () => T): T {
    return maybeTransacting(this.__liminalDocument__, fn);
  }

  get isLiminal(): boolean {
    return docLiminality.has(this.doc);
  }

  /**
   * Active liminality session telemetry span. Set in `enterLiminality`,
   * ended in `commitLiminality` (outcome=commit) or `revertLiminality`
   * (outcome=revert). `null` outside a session.
   */
  private __liminalSpan__: TelemetrySpan | null = null;
  private __liminalSessionStartedAt__ = 0;

  /**
   * Emit point-in-time doc-health telemetry. Consumers call this on
   * a schedule (typical: 1Hz) to surface tombstone/snapshot growth
   * before it surfaces as user-visible slowness.
   *
   * Emits (when telemetry is enabled):
   *   - `plexus.doc.encoded_size_bytes` gauge — full state-as-update size
   *   - `plexus.doc.entity_count` gauge — total entities across types
   *   - `plexus.doc.encoded_to_entity_ratio` gauge — bytes per entity
   *
   * The CRDT-cohort canonical signal: ratio > 5x typical means a stuck
   * client is pinning tombstones via an old state vector. Healthy
   * editors with steady-state usage hold a roughly constant ratio.
   */
  emitDocHealthTelemetry(): void {
    if (!telemetry.enabled) return;
    const encoded = Y.encodeStateAsUpdate(this.doc);
    let entityCount = 0;
    for (const typeMap of this.yTypes.values()) {
      entityCount += typeMap.size;
    }
    telemetry.gauge("plexus.doc.encoded_size_bytes", encoded.byteLength);
    telemetry.gauge("plexus.doc.entity_count", entityCount);
    if (entityCount > 0) {
      telemetry.gauge("plexus.doc.encoded_to_entity_ratio", encoded.byteLength / entityCount);
    }
  }

  enterLiminality(): void {
    if (this.isLiminal) return;
    this.__liminalDocument__.clientID++;
    this.__liminalHeight__++;
    docLiminality.set(this.doc, this.__liminalDocument__);
    docTransactionOrigin.set(this.__liminalDocument__, LIMINAL_ORIGIN);
    this._startBroadcastLoop();
    if (telemetry.enabled) {
      this.__liminalSessionStartedAt__ = performance.now();
      this.__liminalSpan__ = telemetry.span("plexus.liminality.session", {
        liminal_height: this.__liminalHeight__,
      });
      telemetry.counter("plexus.liminality.enter");
    }
  }

  commitLiminality(): void {
    if (!this.isLiminal) return;

    const limId = this.__liminalDocument__.clientID;
    const delta = extractCommittedDelta(this.__liminalDocument__, this.doc, limId, LIMINAL_BASE);
    if (telemetry.enabled) {
      telemetry.histogram("plexus.liminality.commit_delta_bytes", delta.byteLength);
    }

    // Apply to main FIRST. Main→shadow forwarding propagates committed Items to shadow while
    // liminal scaffolding is intact (YATA origin references resolve in the pre-undo state).
    this.__undoManager__.stopCapturing();
    Y.applyUpdate(this.doc, delta, COMMIT_DELTA_ORIGIN);
    this.__undoManager__.stopCapturing();

    // Remove scaffolding. Only needed if the session created Items (inserts/writes).
    // Pure deletes have no limId structs — the committed delta's delete set handles them
    // via main→shadow forwarding. UM undo on pure deletes would create ghost restorations.
    const hasLiminalStructs = !!(this.__liminalDocument__.store as unknown as { clients: Map<number, { length: number }> }).clients.get(limId)?.length;
    if (hasLiminalStructs) {
      // Track clock before/after UM undo. The UM may create NEW Items to "restore" deleted
      // array elements (ghost Items from mixed insert+delete sessions). Delete the ghost range.
      const shadowCid = this.__liminalDocument__.clientID;
      const clockBefore = getMaxClock(this.__liminalDocument__, shadowCid);
      while (this.__liminalUndoManager__.canUndo()) this.__liminalUndoManager__.undo();
      const clockAfter = getMaxClock(this.__liminalDocument__, shadowCid);
      if (clockAfter > clockBefore) {
        Y.applyUpdate(
          this.__liminalDocument__,
          buildDeleteSetUpdate(this.__liminalDocument__, shadowCid, clockBefore, clockAfter - clockBefore),
          FROM_MAIN,
        );
      }
    }
    this.__liminalUndoManager__.stopCapturing();

    // Fresh clientId — main never saw the liminal clocks, so continuing with the same ID
    // would create a clock gap and silently drop subsequent normal writes.
    this.__liminalDocument__.clientID++;

    docTransactionOrigin.set(this.__liminalDocument__, SHADOW_TO_MAIN);
    this._stopBroadcastLoop();
    (this.awareness as PlexusAwareness).clearField("liminal");
    docLiminality.delete(this.doc);
    this.__undoManager__.stopCapturing();
    if (telemetry.enabled && this.__liminalSpan__) {
      this.__liminalSpan__.end({
        outcome: "commit",
        duration_ms: performance.now() - this.__liminalSessionStartedAt__,
      });
      telemetry.counter("plexus.liminality.commit");
      this.__liminalSpan__ = null;
    }
  }

  revertLiminality(): void {
    if (!this.isLiminal) return;

    while (this.__liminalUndoManager__.canUndo()) this.__liminalUndoManager__.undo();
    this.__liminalDocument__.clientID++;

    docTransactionOrigin.set(this.__liminalDocument__, SHADOW_TO_MAIN);
    this._stopBroadcastLoop();
    (this.awareness as PlexusAwareness).clearField("liminal");
    docLiminality.delete(this.doc);
    if (telemetry.enabled && this.__liminalSpan__) {
      this.__liminalSpan__.end({
        outcome: "revert",
        duration_ms: performance.now() - this.__liminalSessionStartedAt__,
      });
      telemetry.counter("plexus.liminality.revert");
      this.__liminalSpan__ = null;
    }
  }

  /**
   * Broadcast current liminal preview to peers via awareness.
   * Can be called manually or via startLiminalBroadcast() for adaptive auto-broadcast.
   * No-op when not liminal.
   *
   * Field format: [height, startSec, base64delta]
   */
  broadcastLiminalPreview(): void {
    if (!this.isLiminal) return;
    const delta = Y.encodeStateAsUpdate(this.__liminalDocument__, Y.encodeStateVector(this.doc));
    (this.awareness as PlexusAwareness).setField("liminal", [
      this.__liminalHeight__,
      Math.floor(time.getUnixTime() / 1000),
      toBase64(delta),
    ]);
  }

  // ── Adaptive liminal broadcast ─────────────────────────────────────
  //
  // Uses PressureObserver (Chrome 125+) when available to adapt broadcast
  // cadence to CPU pressure. Falls back to fixed requestAnimationFrame.
  //
  // Pressure levels → broadcast strategy:
  //   nominal:  every frame (requestAnimationFrame)
  //   fair:     every 2nd frame
  //   serious:  every 4th frame
  //   critical: every 8th frame

  private __broadcastHandle__: number | null = null;
  private __broadcastSkip__ = 1;
  private __pressureObserver__: any = null;

  /** Start auto-broadcasting liminal preview at adaptive cadence. Called at enterLiminality. */
  private _startBroadcastLoop(): void {
    if (this.__broadcastHandle__ !== null) return;
    if (typeof requestAnimationFrame === "undefined") return; // Node/SSR — manual broadcast only

    // PressureObserver: adapt skip factor based on CPU pressure
    if (typeof globalThis !== "undefined" && "PressureObserver" in globalThis) {
      try {
        this.__pressureObserver__ = new (globalThis as any).PressureObserver(
          (records: any[]) => {
            const state = records.at(-1)?.state;
            this.__broadcastSkip__ = state === "critical" ? 8 : state === "serious" ? 4 : state === "fair" ? 2 : 1;
          },
          { sampleInterval: 1000 },
        );
        this.__pressureObserver__.observe("cpu");
      } catch {
        // PressureObserver not supported or permission denied
      }
    }

    let frame = 0;
    const tick = () => {
      if (!this.isLiminal) {
        this._stopBroadcastLoop();
        return;
      }
      if (frame++ % this.__broadcastSkip__ === 0) this.broadcastLiminalPreview();
      this.__broadcastHandle__ = requestAnimationFrame(tick);
    };
    this.__broadcastHandle__ = requestAnimationFrame(tick);
  }

  /** Stop auto-broadcasting. Called at commit/revert. */
  private _stopBroadcastLoop(): void {
    if (this.__broadcastHandle__ !== null) {
      cancelAnimationFrame(this.__broadcastHandle__);
      this.__broadcastHandle__ = null;
    }
    if (this.__pressureObserver__) {
      this.__pressureObserver__.disconnect();
      this.__pressureObserver__ = null;
    }
    this.__broadcastSkip__ = 1;
  }

  // ── Peer preview receiver ───────────────────────────────────────────
  //
  // Per-peer UndoManager on the shadow doc. Each peer's preview is applied
  // with a unique origin; the UM tracks only that origin. On session end,
  // UM undo restores pre-preview values (the only Yjs-native way to un-delete
  // superseded Y.Map Items). Preview origin uses FROM_MAIN to prevent
  // shadow→main forwarding.
  //
  // On commit, the committed delta already carries a limId delete set
  // (merged in extractCommittedDelta). Peers auto-clean via Yjs sync.
  // The UM undo is still needed for the revert path.

  private readonly __peerPreviews__ = new Map<number, { height: number; um: UndoManager; origin: symbol }>();

  applyPeerPreview(peerId: number, data: [number, number, string] | null | undefined): void {
    const existing = this.__peerPreviews__.get(peerId);

    if (data == null) {
      if (existing) {
        while (existing.um.canUndo()) existing.um.undo();
        existing.um.destroy();
        this.__peerPreviews__.delete(peerId);
      }
      return;
    }

    const [height, , base64delta] = data;

    if (existing && existing.height !== height) {
      while (existing.um.canUndo()) existing.um.undo();
      existing.um.destroy();
      this.__peerPreviews__.delete(peerId);
    }

    let entry = this.__peerPreviews__.get(peerId);
    if (!entry) {
      // Per-peer origin — blocked from shadow→main by FROM_MAIN guard below.
      // We apply with FROM_MAIN to prevent forwarding, but wrap in a transaction
      // with the per-peer origin so the UM tracks it correctly.
      const origin = Symbol(`peer-preview-${peerId}`);
      const um = new UndoManager(getModelTypesMap(this.__liminalDocument__), {
        trackedOrigins: new Set([origin]),
        captureTimeout: 0,
      });
      entry = { height, um, origin };
      this.__peerPreviews__.set(peerId, entry);
    }

    // Apply with per-peer origin (UM tracks it). FROM_MAIN wrapper prevents forwarding.
    this.__liminalDocument__.transact(() => {
      Y.applyUpdate(this.__liminalDocument__, fromBase64(base64delta), entry!.origin);
    }, entry.origin);
  }

  /**
   * Find all instances of ParentClass whose `field` references `node`.
   * Supports all field types. Child fields early-return (ownership is exclusive).
   * Reference fields use WeakSet dedup and yield all matches.
   */
  *parentsOf<P extends PlexusModel>(node: PlexusModel, parentClass: PlexusConstructor<P>, field: string): Generator<P> {
    const fieldType = parentClass.schema[field];
    invariant(fieldType, `parentsOf: field "${field}" does not exist on ${parentClass.modelName}`);
    const candidates = this.getAllOfType(parentClass);

    const getField = (c: P): unknown => (c as unknown as Record<string, unknown>)[field];
    switch (fieldType) {
      // ── Child fields: ownership exclusive, at most one parent ──
      case "child-val": {
        for (const c of candidates) {
          if (getField(c) === node) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-list": {
        for (const c of candidates) {
          if ((getField(c) as unknown[]).includes(node)) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-set": {
        for (const c of candidates) {
          if ((getField(c) as Set<unknown>).has(node)) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-record": {
        for (const c of candidates) {
          if (Object.values(getField(c) as Record<string, unknown>).includes(node)) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-map": {
        for (const c of candidates) {
          for (const v of (getField(c) as Map<unknown, unknown>).values()) {
            if (v === node) {
              yield c;
              return;
            }
          }
        }
        break;
      }

      // ── Reference fields: multiple parents possible, dedup via seen ──
      case "val": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (getField(c) === node && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "list": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if ((getField(c) as unknown[]).includes(node) && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "set": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if ((getField(c) as Set<unknown>).has(node) && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "record": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (Object.values(getField(c) as Record<string, unknown>).includes(node) && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "map": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (seen.has(c)) continue;
          for (const v of (getField(c) as Map<unknown, unknown>).values()) {
            if (v === node) {
              seen.add(c);
              yield c;
              break;
            }
          }
        }
        break;
      }
    }
  }

  addDependency(projectId: string, blob: Uint8Array): Root {
    invariant(
      Object.hasOwn(this.root, "dependencies"),
      `Plexus<document#${this.doc.clientID}>.addDependency: root model does not support dependencies`,
    );
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      !dependencies.has(projectId),
      `Plexus<document#${this.doc.clientID}>.addDependency: dependency "${projectId}" already exists`,
    );

    // Auto-detect format: if it's a Y.Doc state vector, convert to blob
    const finalBlob = this.#ensureBlobFormat(projectId, blob);

    maybeTransacting(this.doc, () => {
      dependencies.set(projectId, finalBlob);
    });

    const decoded = this.#ensureDecoded(projectId);
    return this.#materializeDependencyEntity(projectId, decoded.rootUuid) as Root;
  }

  replaceDependency(projectId: string, blob: Uint8Array): Root {
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      dependencies.has(projectId),
      `Plexus<document#${this.doc.clientID}>.replaceDependency: dependency "${projectId}" not found`,
    );

    const finalBlob = this.#ensureBlobFormat(projectId, blob);

    // Invalidate caches
    this.#decodedBlobs.delete(projectId);
    for (const key of this.#dependencyEntityCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        this.#dependencyEntityCache.delete(key);
      }
    }

    maybeTransacting(this.doc, () => {
      dependencies.set(projectId, finalBlob);
    });

    const decoded = this.#ensureDecoded(projectId);
    return this.#materializeDependencyEntity(projectId, decoded.rootUuid) as Root;
  }

  /**
   * Remove a dependency. References become dangling (deref throws).
   */
  removeDependency(projectId: string): void {
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      dependencies.has(projectId),
      `Plexus<document#${this.doc.clientID}>.removeDependency: dependency "${projectId}" not found`,
    );

    // Invalidate caches
    this.#decodedBlobs.delete(projectId);
    for (const key of this.#dependencyEntityCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        this.#dependencyEntityCache.delete(key);
      }
    }

    maybeTransacting(this.doc, () => {
      dependencies.delete(projectId);
    });
  }

  public getDependencyEntity(projectId: string, entityUuid: string): PlexusModel {
    invariant(this.yDependencies.has(projectId), `Plexus: dependency "${projectId}" not loaded`);
    return this.#materializeDependencyEntity(projectId, entityUuid);
  }

  #ensureBlobFormat(projectId: string, data: Uint8Array): Uint8Array {
    // Try to detect: blob format starts with version byte (1).
    // Y.Doc state vectors start with different bytes.
    // Simple heuristic: try decoding as blob first.
    try {
      decodeBlob(data);
      return data; // Already blob format
    } catch {
      // Not blob format — assume Y.Doc state vector, convert
      return this.#convertDocVectorToBlob(projectId, data);
    }
  }

  #convertDocVectorToBlob(projectId: string, stateVector: Uint8Array): Uint8Array {
    const depDoc = new Y.Doc({ guid: projectId });
    Y.applyUpdate(depDoc, stateVector);

    const depMeta = getMetaMap(depDoc);
    const rootUuid = depMeta.get(YJS_GLOBALS.meta.wellKnown.root);
    invariant(rootUuid, `Plexus: dependency "${projectId}" has no root in meta map`);

    return createBlobFromDoc(depDoc, rootUuid, getModelTypesMap, PlexusWrapper);
  }
}
