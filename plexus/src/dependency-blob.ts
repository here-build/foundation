/**
 * Dependency blob encoder/decoder.
 *
 * Singular blob format for dependency snapshots — one Uint8Array per projectId
 * containing all entities needed to fully materialize the package.
 *
 * Format:
 *   [header]
 *     version: u8 (1)
 *     rootUuid: varstring
 *   [entities]
 *     count: varint
 *     for each entity:
 *       uuid: varstring
 *       sourceProjectId: varstring | "" (empty = own project)
 *       type: varstring (model type name)
 *       parentUuid: varstring | "" (empty = no parent)
 *       attributes: any (lib0 encoded)
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

const BLOB_VERSION = 1;

export interface BlobEntity {
  uuid: string;
  sourceProjectId: string | null;
  type: string;
  /** Parent UUID only — key/metadata not serialized (immutable deps don't need field routing). */
  parentUuid: string | null;
  attributes: Record<string, unknown>;
}

export interface DecodedBlob {
  rootUuid: string;
  entities: Map<string, BlobEntity>;
}

export function encodeBlob(rootUuid: string, entities: BlobEntity[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, BLOB_VERSION);
  encoding.writeVarString(encoder, rootUuid);
  encoding.writeVarUint(encoder, entities.length);
  for (const entity of entities) {
    encoding.writeVarString(encoder, entity.uuid);
    encoding.writeVarString(encoder, entity.sourceProjectId ?? "");
    encoding.writeVarString(encoder, entity.type);
    encoding.writeVarString(encoder, entity.parentUuid ?? "");
    encoding.writeAny(encoder, entity.attributes);
  }
  return encoding.toUint8Array(encoder);
}

export function decodeBlob(data: Uint8Array): DecodedBlob {
  const decoder = decoding.createDecoder(data);
  const version = decoding.readUint8(decoder);
  if (version !== BLOB_VERSION) {
    throw new Error(`Unknown dependency blob version: ${version}`);
  }
  const rootUuid = decoding.readVarString(decoder);
  const count = decoding.readVarUint(decoder);
  const entities = new Map<string, BlobEntity>();
  for (let i = 0; i < count; i++) {
    const uuid = decoding.readVarString(decoder);
    const sourceProjectId = decoding.readVarString(decoder) || null;
    const type = decoding.readVarString(decoder);
    const parentUuid = decoding.readVarString(decoder) || null;
    const attributes = decoding.readAny(decoder);
    entities.set(uuid, { uuid, sourceProjectId, type, parentUuid, attributes });
  }
  return { rootUuid, entities };
}

export function createBlobFromDoc(
  doc: import("yjs").Doc,
  rootUuid: string,
  getModelTypesMap: (doc: import("yjs").Doc) => import("yjs").Map<any>,
  PlexusWrapper: new (element: any) => { hasParent: boolean; parent: string | null },
): Uint8Array {
  const entities: BlobEntity[] = [];
  const typeMap = getModelTypesMap(doc);

  for (const [, typeContainer] of typeMap) {
    for (const [uuid, model] of (typeContainer as import("yjs").Map<any>).entries()) {
      const attributes = Object.fromEntries(
        Object.entries(model.getAttributes())
          .filter(([k]) => k !== "\0")
          .map(([k, v]: [string, any]) => [k, v instanceof Object && "toJSON" in v ? v.toJSON() : v]),
      );
      const wrapper = new PlexusWrapper(model);
      entities.push({
        uuid,
        sourceProjectId: null, // own project
        type: model.nodeName,
        parentUuid: wrapper.hasParent ? wrapper.parent : null,
        attributes,
      });
    }
  }

  return encodeBlob(rootUuid, entities);
}
