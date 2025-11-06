import type { OptionalKeysOf, UnionToIntersection } from "type-fest";
import type * as Y from "yjs";
import { curryMaybeReference } from "./utils";
import { DependencyId } from "./Plexus";
import { PlexusModel } from "./PlexusModel";

export const isPlexusEntity = Symbol("is Plexus proxy");
export const referenceSymbol = Symbol("reference");
export const materializationSymbol = Symbol("materialize proxy structure");
export const requestEmancipationSymbol = Symbol("request emancipation");
export const informAdoptionSymbol = Symbol("report parentship change");
export const informOrphanizationSymbol = Symbol("report orphanage");
export const requestAdoptionSymbol = Symbol("report parentship change");
export const requestOrphanizationSymbol = Symbol("report orphanage");
export const backingStorageSymbol = Symbol("backing storage");

export type ParentReference = [entityId: string, fieldName: string, metadata?: string];
// New tuple-based references (memory optimized)
type LocalReferenceeTuple = [entityId: string];
export type CrossProjectReferenceTuple = [entityId: string, dependencyId: DependencyId];
export type ReferenceTuple = LocalReferenceeTuple | CrossProjectReferenceTuple;

export type AllowedPrimitive = string | number | boolean | null;
export type AllowedYValue = AllowedPrimitive | ReferenceTuple;
export type AllowedYJSValue = AllowedPrimitive | PlexusModel;
export type AllowedYJSValueSet = Set<AllowedYJSValue>;
export type AllowedYJSValueMap = Record<string, AllowedYJSValue>;
export type AllowedYJSValueList = AllowedYJSValue[];
export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

type LastOfUnion<T> =
  UnionToIntersection<T extends any ? () => T : never> extends () => infer R
    ? R
    : never;

// system this complex is needed to materialize readonly flag WITHOUT touching field itself that will cause cyclic dependency triggered
// it can be obviously done with ReadonlyKeys from type-fest when we're not dealing on cyclic dependencies but for our case this is crucial
type IsFieldReadonly<A extends ModelStateInit, Key extends keyof A> =
  (<G>() => G extends ({ [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2) extends <
    G
  >() => G extends ({ readonly [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2
    ? Key
    : never;

type ReadonlyFields<A extends ModelStateInit, ExcludedKeys extends keyof A = never> =
  LastOfUnion<Exclude<keyof A, ExcludedKeys>> extends infer Head extends keyof A
    ? IsFieldReadonly<A, Head> | ReadonlyFields<A, ExcludedKeys | Head>
    : never;

export declare class ReadonlyField<T> {
  assign(value: T): void;
  clear(): void;
  [materializationSymbol](
    struct: Y.Array<AllowedYValue> | Y.Map<AllowedYJSValue>,
    boundMaybeReference: ReturnType<typeof curryMaybeReference>
  ): void;
}

export type LegitimateSchema<T extends ModelStateInit> =
  | Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyFields<T>>
  | OptionalKeysOf<T> extends never
  ? ModelStateInit
  : ModelStateInit extends ModelStateInit
    ? ModelStateInit
    : never;

declare const tag: unique symbol;

export type PlexusTagContainer<Token> = {
  readonly [tag]: Token;
};

export type PlexusUUID<Type, Model extends PlexusModel> = Type & PlexusTagContainer<{ model: Model }>;

export type ModelStateInit = Record<
  string,
  AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
>;

export type MaterializedRecordSchemaReadonlyKeys<T extends ModelStateInit> = keyof {
  [key in keyof T as T[key] extends PlexusModel | AllowedPrimitive ? never : key]: key extends typeof tag ? never : key;
};

export type GenericRecordSchema = Record<string, `${"child-" | ""}${"val" | "record" | "set" | "list"}`>;
