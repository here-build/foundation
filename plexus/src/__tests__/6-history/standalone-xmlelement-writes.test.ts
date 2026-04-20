/**
 * Test: standalone Y.XmlElement attribute writes, clock sequencing,
 * and deleteFilter-based entity shell protection.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

describe("Standalone XmlElement attribute writes", () => {
  it("attributes set before insertion are visible after insertion", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");

    const el = new Y.XmlElement("TestNode");

    doc.transact(() => {
      el.setAttribute("name", "hello");
      el.setAttribute("count", "42");
      root.set("node", el);
    });

    expect(el.getAttribute("name")).toBe("hello");
    expect(el.getAttribute("count")).toBe("42");
  });

  it("attributes set before insertion get proper clocks", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");

    const clockBefore = Y.getState(doc.store, doc.clientID);

    const el = new Y.XmlElement("TestNode");

    doc.transact(() => {
      el.setAttribute("field1", "a");
      el.setAttribute("field2", "b");
      root.set("node", el);
    });

    const clockAfter = Y.getState(doc.store, doc.clientID);

    expect(clockAfter).toBeGreaterThan(clockBefore);
    expect(clockAfter - clockBefore).toBeGreaterThanOrEqual(3);
  });

  it("insertion clock is higher than attribute clocks when inserted last", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");

    const el = new Y.XmlElement("TestNode");

    let clockAfterAttrs = 0;
    let clockAfterInsert = 0;

    doc.transact(() => {
      el.setAttribute("field1", "a");
      el.setAttribute("field2", "b");
      clockAfterAttrs = Y.getState(doc.store, doc.clientID);

      root.set("node", el);
      clockAfterInsert = Y.getState(doc.store, doc.clientID);
    });

    expect(clockAfterInsert).toBeGreaterThan(clockAfterAttrs);
  });

  it("attributes set AFTER insertion also work (current behavior)", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");

    const el = new Y.XmlElement("TestNode");

    doc.transact(() => {
      root.set("node", el);
      el.setAttribute("name", "hello");
    });

    expect(el.getAttribute("name")).toBe("hello");
  });

  it("undo reverts attributes but keeps element when using deleteFilter", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.XmlElement>("types");

    const um = new Y.UndoManager(root, {
      trackedOrigins: new Set([null]),
      deleteFilter: (item) => {
        if (item.parent === root && item.parentSub !== null) {
          return false;
        }
        return true;
      },
    });

    const el = new Y.XmlElement("TestNode");

    doc.transact(() => {
      el.setAttribute("name", "hello");
      el.setAttribute("count", "42");
      root.set("myEntity", el);
    });

    expect(root.get("myEntity")).toBe(el);
    expect(el.getAttribute("name")).toBe("hello");

    um.undo();

    expect(root.has("myEntity")).toBe(true);
    expect(el.getAttribute("name")).toBeUndefined();
    expect(el.getAttribute("count")).toBeUndefined();

    um.redo();

    expect(el.getAttribute("name")).toBe("hello");
    expect(el.getAttribute("count")).toBe("42");
    expect(root.get("myEntity")).toBe(el);
  });

  it("force-rewrite: re-setAttribute after integration produces new clock", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.XmlElement>("root");

    const el = new Y.XmlElement("TestNode");
    el.setAttribute("name", "hello");
    el.setAttribute("count", "42");

    let clockAfterIntegration = 0;
    let clockAfterRewrite = 0;

    doc.transact(() => {
      root.set("node", el);
      clockAfterIntegration = Y.getState(doc.store, doc.clientID);

      el.setAttribute("name", "hello");
      el.setAttribute("count", "42");
      clockAfterRewrite = Y.getState(doc.store, doc.clientID);
    });

    expect(clockAfterRewrite).toBeGreaterThan(clockAfterIntegration);
    expect(el.getAttribute("name")).toBe("hello");
    expect(el.getAttribute("count")).toBe("42");
  });
});
