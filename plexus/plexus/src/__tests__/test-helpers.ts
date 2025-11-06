import * as Y from "yjs";
import { YJS_GLOBALS } from "../YJS_GLOBALS";


export function primeDoc(doc: Y.Doc) {
  // Ensure base maps exist
  doc.getMap(YJS_GLOBALS.models);
  doc.getMap(YJS_GLOBALS.metadataMap);
}
