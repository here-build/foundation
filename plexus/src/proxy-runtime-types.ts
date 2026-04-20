import type * as Y from "yjs";

import type { PlexusModel } from "./PlexusModel.js";
import type { PlexusWrapper } from "./PlexusWrapper.js";
import type { curryMaybeReference } from "./utils/utils.js";

export const referenceSymbol = Symbol("reference");
export const materializationSymbol = Symbol("materialize proxy structure");
export const requestEmancipationSymbol = Symbol("request emancipation");
export const informAdoptionSymbol = Symbol("report parentship change");
export const informOrphanizationSymbol = Symbol("report orphanage");
export const requestAdoptionSymbol = Symbol("report parentship change");
export const requestOrphanizationSymbol = Symbol("report orphanage");
export const validateAdoptionSymbol = Symbol("validate adoption");

// New tuple-based references (memory optimized)
type LocalReferenceeTuple = [entityId: string];
export type CrossProjectReferenceTuple = [entityId: string, dependencyId: string];
export type ReferenceTuple = LocalReferenceeTuple | CrossProjectReferenceTuple;

export type AllowedPrimitive = string | number | boolean | bigint | null;

/**
 * Type constraint for awareness field values.
 * JSON-serializable, but PlexusModel instances are valid leaves.
 * Serialization replaces PlexusModel → { "\0": [uuid] } markers.
 * Deserialization returns lazy proxies that resolve markers to live entities.
 */
export type AwarenessSerializable =
  | string
  | number
  | boolean
  | null
  | PlexusModel
  | readonly AwarenessSerializable[]
  | { readonly [key: string]: AwarenessSerializable };

/** Shape constraint for awareness fields — each field must be AwarenessSerializable (or undefined for optional fields). */
export type AwarenessShape = Record<string, AwarenessSerializable | undefined>;
export type AllowedYValue = AllowedPrimitive | ReferenceTuple;
export type AllowedYJSValue = AllowedPrimitive | PlexusModel;
export type AllowedYJSValueSet = Set<AllowedYJSValue>;
export type AllowedYJSValueMap = Record<string, AllowedYJSValue>;
export type AllowedYJSValueList = AllowedYJSValue[];
export type AllowedYJSMapKey = AllowedYJSValue | Set<AllowedYJSValue> | AllowedYJSValue[];
export type AllowedVirtualMapKey = AllowedPrimitive | AllowedPrimitive[] | PlexusModel;

/** @internal Brand symbol — makes VirtualMap unconstructable from outside Plexus. */
declare const __virtualMapBrand: unique symbol;

export interface VirtualMap<K extends AllowedVirtualMapKey, V> extends Omit<ReadonlyMap<K, V>, "get"> {
  get(key: K): V;
  /** Prevents assignment — no externally constructed value satisfies this branded type. */
  readonly [__virtualMapBrand]: never;
}

export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

export type YPlexusNode = Y.XmlElement<Record<string, Storageable>>;

export declare class ReadonlyField<T> {
  assign(value: T): void;

  clear(): void;

  [materializationSymbol](
    struct: Y.Array<AllowedYValue> | Y.Map<AllowedYJSValue>,
    boundMaybeReference: ReturnType<typeof curryMaybeReference>,
  ): void;
}

declare const tag: unique symbol;

export interface PlexusTagContainer<Token> {
  readonly [tag]?: Token;
}

export type PlexusUUID = string & PlexusTagContainer<"plexus-uuid">;

export type GenericRecordSchema = Record<string, `${"child-" | ""}${"val" | "record" | "set" | "list" | "map"}`>;

export type Internals<Parent extends PlexusModel | null> =
  | {
      isDependency?: false;
      parent: Parent | null;
      parentKey: string | null;
      parentMetadata: string | null;
      initializationState: Record<
        string,
        AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList | undefined
      >;
      isWithinYjsModelSeed: boolean;
      yjsModel?: PlexusWrapper;
      uuid?: PlexusUUID;
      reference?: ReferenceTuple;
      backingStorage: Map<string, any>;
      isRoot?: boolean;
      unobserve?: () => void;
      /**
       * How this entity was created — determines UUID prefix and lifecycle rules.
       * - undefined: normal entity (p-prefix, full lifecycle)
       * - "derived": virtual genesis child (d-prefix, reparent/detach blocked)
       * - "bound": cloned into virtual map (b-prefix, reparent/detach blocked)
       */
      binding?: "derived" | "bound";
      /**
       * Clock state after initial materialization completes (session-scoped).
       * Items inside this entity's XmlElement with clock < this value are creation
       * content — protected from undo by the deleteFilter.
       * Items with clock >= this value are post-creation modifications — undoable.
       */
      materializationClock?: number;
      /** The clientID that performed the materialization (for clock comparison). */
      materializationClient?: number;
    }
  | {
      isDependency: true;
      documentId: string;
      uuid: PlexusUUID;
      parent: Parent;
      isRoot?: boolean;
      reference: [string, string];
      parentKey: null;
      parentMetadata: null;
    };
