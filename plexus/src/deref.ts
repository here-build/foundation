// Dereference tuple references via CRDT-native UUID → StructStore resolution

import invariant from "tiny-invariant";
import * as Y from "yjs";

import { decode } from "./crdt-uuid.js";
import { documentEntityCaches } from "./entity-cache.js";
import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { Plexus } from "./Plexus.js";
import type { ConcretePlexusConstructor } from "./PlexusModel.js";
import { getInternals, PlexusModel } from "./PlexusModel.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYJSValue, AllowedYValue, PlexusUUID, YPlexusNode } from "./proxy-runtime-types.js";
import { isTupleReference } from "./utils/utils.js";
import { getModelTypesMap } from "./yjs/getModels.js";

export function deref<T extends AllowedYJSValue>(
  doc: Y.Doc,
  pointer: AllowedYValue | undefined,
  contextualDocumentId?: string, // only used for dependency docs internals
): T {
  if (pointer == null) {
    return null as T;
  }
  if (typeof pointer !== "object") {
    return pointer as T;
  }

  if (!isTupleReference(pointer)) {
    // Not a reference, return as-is
    return pointer;
  }

  const entityId = pointer[0];

  const alteredDocumentId = pointer[1] ?? contextualDocumentId;
  if (alteredDocumentId) {
    return docPlexus.get(doc)!.getDependencyEntity(alteredDocumentId, entityId) as T;
  }

  // Entity cache check first — O(1) if already resolved
  const entityCache = documentEntityCaches.get(doc);
  const knownEntity = entityCache.get(entityId)?.deref();
  if (knownEntity) {
    return knownEntity as T;
  }

  let entityModel: YPlexusNode | undefined = undefined;
  if (Plexus.uuidMode === "arbitrary") {
    const typeModelsMap = getModelTypesMap(doc);
    for (const value of typeModelsMap.values()) {
      if (value.has(entityId)) {
        entityModel = value.get(entityId);
        break;
      }
    }
  } else {
    // CRDT-native UUID → StructStore resolution — O(log n)
    // decode reverses the Feistel cipher to recover {clientId, clock},
    // then getItem does a binary search in the StructStore.
    const { clientId, clock } = decode(entityId as PlexusUUID);
    const item = Y.getItem(doc.store, Y.createID(clientId, clock));
    invariant(
      item.content instanceof Y.ContentType,
      `Plexus<model#${entityId}>: decoded item is not a ContentType (got ${item.content?.constructor?.name})`,
    );
    entityModel = item.content.type as YPlexusNode;
  }

  invariant(
    entityModel instanceof Y.XmlElement,
    `Plexus<model#${entityId}>: decoded item content is not XmlElement (got ${entityModel?.constructor?.name})`,
  );

  const targetType = entityModel.nodeName;
  invariant(typeof targetType === "string", `Plexus<model#${entityId}>: missing type (nodeName)`);

  const ModelConstructor = entityClasses.get(targetType) as ConcretePlexusConstructor;
  invariant(ModelConstructor, `Plexus<${targetType}#${entityId}>: class not registered in entityClasses`);

  const model = PlexusModel.__materializeRaw__(ModelConstructor);
  const internals = getInternals(model);
  invariant(
    !internals.isDependency,
    `Plexus<${targetType}#${entityId}>: raw materialization spawned dependency — bug in Plexus`,
  );
  internals.uuid = entityId as PlexusUUID;
  internals.yjsModel = new PlexusWrapper(entityModel);
  entityCache.set(entityId, new WeakRef(model));

  // Resolve parent from YJS wrapper BEFORE bootstrap.
  // Parent is always cached already (top-down materialization from root),
  // so this deref is a cache hit. Setting parent on internals ensures
  // informAdoptionSymbol's early-return fires during bootstrap,
  // avoiding [referenceSymbol] calls before docPlexus is registered.
  if (internals.yjsModel.hasParent) {
    internals.parent = deref(doc, [internals.yjsModel.parent!]);
    internals.parentKey = internals.yjsModel.parentKey;
    internals.parentMetadata = internals.yjsModel.parentMetadata;
  }

  model.__bootstrapObservation__();
  return model as T;
}
