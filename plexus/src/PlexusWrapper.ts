import type * as Y from "yjs";

import type { Storageable, YPlexusNode } from "./proxy-runtime-types.js";

/**
 * Map-alike wrapper around Y.XmlElement.
 * Bridges the gap between the old Y.Map API (get/set/delete/has)
 * and Y.XmlElement's attribute API (getAttribute/setAttribute/removeAttribute).
 *
 * Parent data is stored as positional children: [entityId, key, meta?]
 * Each child is an XmlElement whose nodeName carries the value.
 * Any change clears all children and re-inserts (cross-product assignment).
 */
export class PlexusWrapper {
  constructor(public readonly element: YPlexusNode) {}

  get doc(): Y.Doc | null {
    return this.element.doc;
  }

  get nodeName(): string {
    return this.element.nodeName;
  }

  get hasParent(): boolean {
    return this.parentData.length > 0;
  }

  get parentData() {
    type t = Exclude<keyof Y.Array<any> & keyof Y.XmlFragment, `_${string}`>;
    return this.element as any as Pick<Y.Array<string>, t>;
  }

  get parent(): string | null {
    return this.parentData.get(0) ?? null;
  }

  get parentKey(): string | null {
    return this.parentData.get(1) ?? null;
  }

  // --- Parent data: positional children [entityId, key, meta?] ---

  get parentMetadata(): string | null {
    return this.parentData.get(2) ?? null;
  }

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
    const len = this.element.length;
    const expectedLen = metadata == null ? 2 : 3;

    // No-op if values already match
    if (
      len === expectedLen &&
      this.parent === entityId &&
      this.parentKey === key &&
      (metadata == null || this.parentMetadata === metadata)
    ) {
      return;
    }

    // Cross-product: clear all + re-insert
    if (len > 0) {
      this.parentData.delete(0, len);
    }
    const children: string[] = [entityId, key];
    if (metadata != null) {
      children.push(metadata);
    }
    this.parentData.insert(0, children);
  }

  clearParentData(): void {
    const len = this.parentData.length;
    if (len > 0) {
      this.parentData.delete(0, len);
    }
  }
}
