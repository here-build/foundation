import type * as Y from "yjs";

import type { Storageable, YPlexusNode } from "./proxy-runtime-types.js";

/**
 * Map-alike wrapper around Y.XmlElement.
 * Bridges the gap between the old Y.Map API (get/set/delete/has)
 * and Y.XmlElement's attribute API (getAttribute/setAttribute/removeAttribute).
 *
 * Parent data is stored as an atomic attribute at key "\0":
 * a plain JS tuple [entityId, key, metadata?]. Yjs attributes are
 * last-write-wins, preventing partial merges under concurrent edits.
 */
export class PlexusWrapper {
  static readonly PARENT_ATTR = "\0";

  constructor(public readonly element: YPlexusNode) {}

  get doc(): Y.Doc | null {
    return this.element.doc;
  }

  get nodeName(): string {
    return this.element.nodeName;
  }

  // --- Parent data: atomic attribute "\0" = [entityId, key, metadata?] ---

  get hasParent(): boolean {
    return this.element.hasAttribute(PlexusWrapper.PARENT_ATTR);
  }

  private get parentTuple(): string[] | undefined {
    return this.element.getAttribute(PlexusWrapper.PARENT_ATTR) as string[] | undefined;
  }

  get parent(): string | null {
    return this.parentTuple?.[0] ?? null;
  }

  get parentKey(): string | null {
    return this.parentTuple?.[1] ?? null;
  }

  get parentMetadata(): string | null {
    return this.parentTuple?.[2] ?? null;
  }

  // --- Schema field access (attributes) ---

  get(key: string): Storageable | undefined {
    return this.element.getAttribute(key);
  }

  set(key: string, value: Storageable): void {
    this.element.setAttribute(key, value);
  }

  delete(key: string): void {
    this.element.removeAttribute(key);
  }

  has(key: string): boolean {
    return this.element.hasAttribute(key);
  }

  setParentData(entityId: string, key: string, metadata?: string | null): void {
    const current = this.parentTuple;
    const hasMetadata = metadata != null;
    const expectedLen = hasMetadata ? 3 : 2;

    if (
      current &&
      current.length === expectedLen &&
      current[0] === entityId &&
      current[1] === key &&
      (!hasMetadata || current[2] === metadata)
    ) {
      return;
    }

    const tuple: string[] = hasMetadata ? [entityId, key, metadata!] : [entityId, key];
    (this.element.setAttribute as (k: string, v: unknown) => void)(PlexusWrapper.PARENT_ATTR, tuple);
  }

  clearParentData(): void {
    if (this.hasParent) {
      this.element.removeAttribute(PlexusWrapper.PARENT_ATTR);
    }
  }
}
