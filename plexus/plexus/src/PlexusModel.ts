import * as Y from "yjs";
import "@here.build/arrival-env";
import {
  AllowedYJSValue,
  AllowedYJSValueList,
  AllowedYJSValueMap,
  AllowedYJSValueSet,
  AllowedYValue,
  backingStorageSymbol,
  GenericRecordSchema,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  ParentReference,
  PlexusUUID,
  referenceSymbol,
  ReferenceTuple,
  requestAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  Storageable
} from "./proxy-runtime-types";
import { documentEntityCaches } from "./entity-cache";
import { curryMaybeReference, maybeTransacting, never } from "./utils";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import invariant from "tiny-invariant";
import { trackAccess, trackModification } from "./tracking";
import { deref } from "./deref";
import { nanoid } from "nanoid";
import { DependencyId, undoManagerNotifications } from "./Plexus";
import { docPlexus } from "./plexus-registry";
import { clone } from "./clone";

export type PlexusConstructor<T extends PlexusModel = PlexusModel> =
  | ((abstract new (...args: any) => T) & {
      modelName: string;
      schema: GenericRecordSchema;
    })
  | ((new (...args: any) => T) & {
      modelName: string;
      schema: GenericRecordSchema;
    });
export type ConcretePlexusConstructor<T extends PlexusModel = PlexusModel> = (new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};
type Initializer<T extends PlexusModel> = [entityId: string, doc: Y.Doc];

let currentlyEmancipating = new WeakSet<PlexusModel>();

export type PlexusInit<T extends PlexusModel> = {
  [key in keyof T as key extends keyof PlexusModel
    ? never
    : T[key] extends AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
      ? key
      : T[key] extends AllowedYJSValue
        ? null extends T[key]
          ? key
          : never
        : never]?: T[key];
} & {
  [key in keyof T as key extends keyof PlexusModel
    ? never
    : T[key] extends AllowedYJSValue
      ? null extends T[key]
        ? never
        : key
      : never]: T[key];
};

export abstract class PlexusModel {
  static modelName: string;
  static schema: GenericRecordSchema;
  // here and in other places we're using accessors only to remove elements from enumerable set
  accessor [backingStorageSymbol] = new Map<string, any>();

  #runtimeParent: PlexusModel | null = null;
  #runtimeParentKey: string | null = null;
  #runtimeParentMetadata: string | null = null;

  get _schema(): GenericRecordSchema {
    return (this.constructor as PlexusConstructor).schema;
  }

  get _type() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  _deref(target: AllowedYValue) {
    invariant(this._doc, "tried to deref without doc");
    return deref(this._doc, target);
  }

  // making things non-enumerable
  accessor _initializationState: Record<
    string,
    AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
  > = {};
  get _doc(): Y.Doc | null {
    return this._yjsModel?.doc ?? null;
  }
  accessor _isWithinYjsModelSeed: boolean = false;
  accessor _yjsModel: Y.Map<Storageable> | null = null;

  constructor(
    init:
      | Record<string, AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList>
      | Initializer<typeof this> = {}
  ) {
    if (Array.isArray(init)) {
      const [entityId, doc] = init;
      const cached = documentEntityCaches.get(doc).get(entityId)?.deref();
      if (cached) {
        console.trace("this is illegal invocation and should not happen");
        return cached as any as typeof this;
      }
      documentEntityCaches.get(doc).set(entityId, new WeakRef<PlexusModel>(this));
      this._uuid = entityId;
      const modelsMap = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
      const map = modelsMap.get(this.uuid);
      invariant(
        map,
        `you are trying to instantiate ${this.constructor.name}#${entityId} that is non-existent on this document`
      );
      const storedType = map.get(YJS_GLOBALS.modelMetadataType) as string;
      invariant(storedType === this.#type, `spawn type mismatch, ${storedType} !== ${this.#type}`);
      this._yjsModel = map;
      // bootstrap should go after documentEntityCaches.set to handle circular dependencies properlt
      this.#bootstrapYjsObservation();
    } else {
      this._initializationState = init;
    }
    Object.defineProperties(
      this,
      Object.fromEntries(
        Object.keys(this._schema).map((key) => {
          let prototype = (this as any).__proto__;
          while (prototype && prototype !== prototype.__proto__) {
            if (Object.hasOwn(prototype, key)) {
              break;
            }
            prototype = prototype.__proto__;
          }
          invariant(prototype, "terribly wrong state");
          return [
            key,
            // this helps us auto-correct user's mistakes when instead of accessor declaration of schema field
            // prop declaration is used - this only happens in children of synced elements, thus, we just need to override
            // "wrong" field with its actual behavior.
            // this also makes all of them enumerable of course. examples of "why it's needed" are in inheritance tests
            {
              ...Object.getOwnPropertyDescriptor(prototype, key),
              enumerable: true,
              configurable: false
            } satisfies PropertyDescriptor
          ] as const;
        })
      )
    );
    Object.seal(this);
  }

  toJSON() {
    return Object.fromEntries(Object.keys(this._schema).map((key) => [key, this[key]]));
  }

  [Symbol.SExpr](): string {
    return this._type;
  }

  [requestEmancipationSymbol]() {
    this.#emancipate();
  }

  [informAdoptionSymbol](
    newParent: Exclude<(typeof this)["parent"], null>,
    field: string,
    extraFieldMetadata?: string
  ) {
    invariant(this._uuid !== "root" || (newParent as PlexusModel) === this, "Root entity cannot have a parent");

    if (
      this.#runtimeParent === newParent &&
      this.#runtimeParentKey === field &&
      this.#runtimeParentMetadata === extraFieldMetadata
    ) {
      return;
    }
    if (!this._yjsModel && newParent._doc) {
      this[referenceSymbol](newParent._doc);
    } else {
      if (newParent._doc && this._doc) {
        invariant(
          newParent._doc === this._doc,
          "entities from other document cannot be passed to child-* fields as this breaks the hierarchy tree"
        );
      }
    }

    this.#runtimeParent = newParent;
    this.#runtimeParentKey = field;
    this.#runtimeParentMetadata = extraFieldMetadata ?? null;

    maybeTransacting(this._doc, () => {
      trackModification(this, "parent");
      if (!this._doc) {
        return;
      }
      const reference = newParent[referenceSymbol](this._doc!);

      (this._yjsModel as Y.Map<any> as Y.Map<ParentReference>).set(
        YJS_GLOBALS.modelMetadataParent,
        extraFieldMetadata ? [reference[0], field, extraFieldMetadata] : [reference[0], field]
      );
    });
  }

  #emancipate() {
    if (!this.parent) {
      return;
    }

    if (currentlyEmancipating.has(this)) {
      return;
    }
    currentlyEmancipating.add(this);

    const parent = this.parent;
    const [_, parentKey, extraParentMetadata] = this._yjsModel
      ? (this._yjsModel.get(YJS_GLOBALS.modelMetadataParent) as ParentReference)
      : [null, this.#runtimeParentKey!, this.#runtimeParentMetadata];
    // avoiding circular dependencies

    this._yjsModel?.delete(YJS_GLOBALS.modelMetadataParent);
    this.#runtimeParent = null;

    switch ((parent.constructor as PlexusConstructor).schema[parentKey]) {
      case "child-val":
        parent[parentKey] = null;
        break;
      case "child-set":
        parent[parentKey].delete(this);
        break;
      case "child-list":
        const childIndex = (parent[parentKey] as any[]).indexOf(this);
        if (childIndex !== -1) {
          (parent[parentKey] as any[]).splice(childIndex, 1);
        }
        break;
      case "child-record":
        delete parent[parentKey][extraParentMetadata!];
        break;
    }
    currentlyEmancipating.delete(this);
  }

  [requestAdoptionSymbol](
    newParent: Exclude<(typeof this)["parent"], null>,
    field: string,
    extraFieldMetadata?: string
  ) {
    const parent = this.parent;
    const oldField = this.#runtimeParentKey;
    const oldExtraFieldMetadata = this.#runtimeParentMetadata;
    this.#emancipate();
    if (parent === newParent && oldField === field && oldExtraFieldMetadata === extraFieldMetadata) {
      return;
    }
    this[informAdoptionSymbol](newParent, field, extraFieldMetadata);
  }
  [informOrphanizationSymbol]() {
    this.#runtimeParent = null;
    this.#runtimeParentKey = null;
    this.#runtimeParentMetadata = null;
    if (this._yjsModel) {
      const currentParent = this._yjsModel.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
      if (currentParent) {
        maybeTransacting(this._doc, () => {
          trackModification(this, "parent");
          // it is VERY important to alter fieldMap first to avoid cyclic processing
          this._yjsModel!.delete(YJS_GLOBALS.modelMetadataParent);
        });
      }
    }
  }

  [requestOrphanizationSymbol]() {
    this.#emancipate();
    this[informOrphanizationSymbol]();
  }

  get parent(): PlexusModel | null {
    trackAccess(this, "parent");
    return this.#runtimeParent;
  }

  clone<T extends PlexusModel>(this: T, newProps: Partial<Omit<T, keyof PlexusModel>> = {}): T {
    return clone(this, newProps);
  }

  accessor _uuid: string | undefined;

  get uuid(): PlexusUUID<string, this> {
    return (this._uuid ??= nanoid()) as PlexusUUID<string, this>;
  }

  get #reference(): ReferenceTuple {
    return [this.uuid] as const;
  }

  get #type() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  [referenceSymbol](doc: Y.Doc): ReferenceTuple {
    invariant(
      docPlexus.has(doc),
      "passed doc is not registered as legitimate Plexus root",
    );
    // this is needed explicitly in that manner for cyclic dependencies.
    // It will never cause cross-doc issues as we only materialize root doc entities.
    // Lucky for us, Plexus is doing not structural but reference equivalence - so we can safely assume that returning pointer will do nothing wrong.
    if (this._yjsModel?.doc) {
      if (doc !== this._yjsModel.doc) {
        const documentId = this._yjsModel.doc
          .getMap(YJS_GLOBALS.metadataMap)
          ?.get(YJS_GLOBALS.metadataMapFields.documentId) as
          | DependencyId
          | undefined;
        invariant(documentId, "cannot cross-reference between docs");
        return [this.uuid, documentId];
      }
      return this.#reference;
    }
    const boundMaybeReference = curryMaybeReference(doc);
    // eslint-disable-next-line sonarjs/no-nested-functions
    return maybeTransacting(doc, () => {
      const yprojectObjectInstances = doc.getMap<Y.Map<Storageable>>(
        YJS_GLOBALS.models,
      );
      // technically, it should not happen at all (as _yjsModel presence is basically equivalent to representation
      // in YJS_GLOBALS.models - but there may be weird edge cases like class rehydration, so better to handle
      // explicitly
      let yprojectObjectInstanceFields = yprojectObjectInstances.get(this.uuid);
      this._isWithinYjsModelSeed = true;
      if (!yprojectObjectInstanceFields) {
        yprojectObjectInstanceFields = new Y.Map<Storageable>();
        yprojectObjectInstances.set(this.uuid, yprojectObjectInstanceFields);
        yprojectObjectInstanceFields.set(
          YJS_GLOBALS.modelMetadataType,
          this.#type,
        );
        if (this.#runtimeParent) {
          const parentReference = this.#runtimeParent[referenceSymbol](doc);
          (
            yprojectObjectInstanceFields as Y.Map<any> as Y.Map<ParentReference>
          ).set(
            YJS_GLOBALS.modelMetadataParent,
            this.#runtimeParentMetadata
              ? [
                  parentReference[0],
                  this.#runtimeParentKey!,
                  this.#runtimeParentMetadata,
                ]
              : [parentReference[0], this.#runtimeParentKey!],
          );
        }
        if (this._uuid) {
          documentEntityCaches
            .get(doc)
            .set(this._uuid, new WeakRef<PlexusModel>(this));
        }
        // it should be placed before schema iteration to avoid circular self-reference issues
        this._yjsModel = yprojectObjectInstanceFields;
      }
      for (const [schemaKey, type] of Object.entries(this._schema)) {
        switch (type) {
          case "val":
          case "child-val":
            yprojectObjectInstanceFields.set(
              schemaKey,
              boundMaybeReference(
                this[backingStorageSymbol].get(schemaKey) as AllowedYJSValue,
              ),
            );
            break;
          case "list":
          case "child-list":
            yprojectObjectInstanceFields.set(
              schemaKey,
              // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
              Y.Array.from(
                // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
                // Convert sparse arrays to dense arrays (holes become null)
                Array.from<AllowedYJSValue, AllowedYValue>(
                  this[schemaKey],
                  boundMaybeReference,
                ),
              ),
            );
            break;
          case "record":
          case "child-record":
            yprojectObjectInstanceFields.set(
              schemaKey,
              new Y.Map<AllowedYValue | null>(
                Object.entries(
                  this[schemaKey] as Record<string, AllowedYJSValue>,
                ).map(([recordKey, val]) => [
                  recordKey,
                  boundMaybeReference(val),
                ]),
              ),
            );
            break;
          case "set":
          case "child-set":
            yprojectObjectInstanceFields.set(
              schemaKey,
              // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
              Y.Array.from(
                // Convert Set to array while mapping references
                // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
                Array.from(this[schemaKey], boundMaybeReference),
              ),
            );
            break;
          default:
            never(type);
        }
      }
      this.#bootstrapYjsObservation();
      documentEntityCaches
        .get(doc)
        .set(this.uuid, new WeakRef<PlexusModel>(this));
      this._isWithinYjsModelSeed = false;
      return this.#reference;
    });
  }

  #bootstrapYjsObservation() {
    invariant(this._yjsModel, "cannot bootstrap observation without yjs model");

    // Initialize runtime parent from Y.js
    const parentReference = this._yjsModel.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
    if (parentReference) {
      this.#runtimeParent = deref(this._doc!, [parentReference[0]]) as PlexusModel;
      this.#runtimeParentKey = parentReference[1];
      this.#runtimeParentMetadata = parentReference[2] ?? null;
    }

    for (const [key, type] of Object.entries(this._schema)) {
      switch (type) {
        case "val":
        case "child-val":
          this[backingStorageSymbol].set(key, deref(this._doc!, this._yjsModel.get(key) as AllowedYValue));
          break;
        case "record":
        case "child-record":
        case "set":
        case "child-set":
        case "list":
        case "child-list":
          this[key][materializationSymbol]();
      }
    }

    const onChange = (event: Y.YMapEvent<any>) => {
      for (const key of event.keysChanged) {
        if (this._schema[key] === "val" || this._schema[key] === "child-val") {
          const oldValue = this[backingStorageSymbol].get(key);
          const yjsValue = this._yjsModel!.get(key) as AllowedYValue;
          const newValue = deref(this._doc!, yjsValue);
          if (key === "primaryChild") {
            console.log("[onChange] primaryChild change detected");
            console.log("  Y.js value:", yjsValue);
            console.log("  oldValue:", oldValue);
            console.log("  newValue:", newValue);
            console.log("  equal?:", oldValue === newValue);
          }
          if (newValue !== oldValue) {
            if (key === "primaryChild") {
              console.log("  -> calling trackModification");
            }
            trackModification(this, key);
            this[backingStorageSymbol].set(key, newValue);
          } else if (key === "primaryChild") {
            console.log("  -> NOT calling trackModification (values equal)");
          }
        } else if (key in this._schema) {
          console.warn("attempted to rewrite the value that should be preserved untouched", this, key);
        } else if (key === YJS_GLOBALS.modelMetadataParent) {
          // Update runtime parent when Y.js changes
          const parentReference = this._yjsModel!.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
          const previousParent = this.parent;
          if (parentReference) {
            this.#runtimeParent = deref(this._doc!, [parentReference[0]]) as PlexusModel;
            this.#runtimeParentKey = parentReference[1];
            this.#runtimeParentMetadata = parentReference[2] ?? null;
          } else {
            this.#runtimeParent = null;
            this.#runtimeParentKey = null;
            this.#runtimeParentMetadata = null;
          }
          // this may be needed e.g. when item moved from one field to another in same parent
          if (this.parent !== previousParent) {
            trackModification(this, "parent");
          }
        } else {
          console.warn("attempted to write the value that is not in schema", this, key);
        }
      }
    };
    undoManagerNotifications.set(this._yjsModel, onChange);
    this._yjsModel!.observe(onChange);
  }
}
