/**
 * Awareness Serde — serialize/deserialize PlexusModel ↔ JSON roundtrip.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { deserialize, serialize } from "../../awareness-serde.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ── Test models ──

@syncing("SerdeEntity")
class SerdeEntity extends PlexusModel {
  @syncing accessor name: string = "test";
}

@syncing("SerdeHost")
class SerdeHost extends PlexusModel {
  @syncing.child accessor child: SerdeEntity | null = null;
}

// ═══════════════════════════════════════════════════════════════════════

describe("serialize", () => {
  it("passes primitives through unchanged", () => {
    expect(serialize(42)).toBe(42);
    expect(serialize("hello")).toBe("hello");
    expect(serialize(true)).toBe(true);
    expect(serialize(null)).toBe(null);
  });

  it("passes plain objects through unchanged (same reference)", () => {
    const obj = { x: 10, y: 20 };
    expect(serialize(obj)).toBe(obj); // same reference — no entities, no copy
  });

  it("passes plain arrays through unchanged (same reference)", () => {
    const arr = [1, 2, 3];
    expect(serialize(arr)).toBe(arr); // same reference
  });

  it("serializes PlexusModel as { '\\0': [uuid] }", () => {
    const entity = new SerdeEntity({ name: "test" });
    const { root } = initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = serialize(entity) as any;
    expect(serialized).toHaveProperty("\0");
    expect(serialized["\0"]).toEqual([entity.uuid]);
  });

  it("serializes entity inside array", () => {
    const entity = new SerdeEntity({ name: "test" });
    const { root } = initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = serialize([entity, "other"]) as any[];
    expect(serialized[0]).toHaveProperty("\0");
    expect(serialized[0]["\0"]).toEqual([entity.uuid]);
    expect(serialized[1]).toBe("other");
  });

  it("serializes entity inside nested object", () => {
    const entity = new SerdeEntity({ name: "test" });
    const { root } = initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = serialize({ selection: entity, tool: "pen" }) as any;
    expect(serialized.selection).toHaveProperty("\0");
    expect(serialized.selection["\0"]).toEqual([entity.uuid]);
    expect(serialized.tool).toBe("pen");
  });

  it("returns new object/array only when entities present", () => {
    const noEntities = { a: 1, b: [2, 3], c: { d: "x" } };
    expect(serialize(noEntities)).toBe(noEntities); // same ref — no copy

    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));
    const withEntities = { a: 1, b: entity };
    expect(serialize(withEntities)).not.toBe(withEntities); // new object
  });

  it("survives JSON roundtrip", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const value = { selection: [entity], cursor: { x: 10, y: 20 } };
    const serialized = serialize(value, entity.__doc__!);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);

    // The marker survives
    expect(parsed.selection[0]).toHaveProperty("\0");
    expect(parsed.selection[0]["\0"]).toEqual([entity.uuid]);
    // Plain data survives
    expect(parsed.cursor).toEqual({ x: 10, y: 20 });
  });
});

describe("deserialize", () => {
  it("passes primitives through", () => {
    const doc = new Y.Doc();
    expect(deserialize(42, doc)).toBe(42);
    expect(deserialize("hello", doc)).toBe("hello");
    expect(deserialize(null, doc)).toBe(null);
    doc.destroy();
  });

  it("resolves entity reference marker", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const marker = { "\0": [entity.uuid] };
    const resolved = deserialize(marker, entity.__doc__!);
    expect(resolved).toBe(entity); // same instance
  });

  it("lazy proxy: object property access resolves entities", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = { selection: { "\0": [entity.uuid] }, tool: "pen" };
    const proxy = deserialize(serialized, entity.__doc__!) as any;

    expect(proxy.tool).toBe("pen");
    expect(proxy.selection).toBe(entity);
  });

  it("lazy proxy: array index access resolves entities", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = [{ "\0": [entity.uuid] }, "other"];
    const proxy = deserialize(serialized, entity.__doc__!) as any[];

    expect(proxy[0]).toBe(entity);
    expect(proxy[1]).toBe("other");
    expect(proxy.length).toBe(2);
  });

  it("lazy proxy: array iteration resolves entities", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = [{ "\0": [entity.uuid] }, "other"];
    const proxy = deserialize(serialized, entity.__doc__!) as any[];

    const mapped = proxy.map((v: any) => v);
    expect(mapped[0]).toBe(entity);
    expect(mapped[1]).toBe("other");
  });

  it("lazy proxy: array includes works with entities", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = [{ "\0": [entity.uuid] }];
    const proxy = deserialize(serialized, entity.__doc__!) as any[];

    expect(proxy.includes(entity)).toBe(true);
    expect(proxy.includes("nope")).toBe(false);
  });

  it("lazy proxy: nested objects resolve recursively", () => {
    const entity = new SerdeEntity({ name: "test" });
    initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = {
      deep: {
        nested: {
          entity: { "\0": [entity.uuid] },
          value: 42,
        },
      },
    };
    const proxy = deserialize(serialized, entity.__doc__!) as any;

    expect(proxy.deep.nested.entity).toBe(entity);
    expect(proxy.deep.nested.value).toBe(42);
  });

  it("lazy proxy: Object.keys works", () => {
    const entity = new SerdeEntity({ name: "test" });
    const { doc } = initTestPlexus(new SerdeHost({ child: entity }));

    const serialized = { sel: { "\0": [entity.uuid] }, tool: "pen" };
    const proxy = deserialize(serialized, doc) as any;

    expect(Object.keys(proxy)).toEqual(["sel", "tool"]);
  });

  it("proxy cache: same source returns same proxy", () => {
    const doc = new Y.Doc();
    const source = { a: 1, b: 2 };
    const proxy1 = deserialize(source, doc);
    const proxy2 = deserialize(source, doc);
    expect(proxy1).toBe(proxy2); // cached
    doc.destroy();
  });
});

describe("roundtrip: serialize → JSON → deserialize", () => {
  it("full roundtrip with mixed entities and primitives", () => {
    const entity = new SerdeEntity({ name: "roundtrip" });
    initTestPlexus(new SerdeHost({ child: entity }));
    const entityDoc = entity.__doc__!;

    const original = {
      selection: [entity],
      cursor: { x: 10, y: 20 },
      name: "Alice",
      empty: null,
    };

    // Serialize
    const serialized = serialize(original, entityDoc);

    // Wire (JSON roundtrip)
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);

    // Deserialize
    const resolved = deserialize(parsed, entityDoc) as any;

    expect(resolved.selection[0]).toBe(entity);
    expect(resolved.cursor.x).toBe(10);
    expect(resolved.cursor.y).toBe(20);
    expect(resolved.name).toBe("Alice");
    expect(resolved.empty).toBe(null);
  });

  it("roundtrip with entity as direct value", () => {
    const entity = new SerdeEntity({ name: "direct" });
    initTestPlexus(new SerdeHost({ child: entity }));
    const entityDoc = entity.__doc__!;

    const serialized = serialize(entity, entityDoc);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const resolved = deserialize(parsed, entityDoc);

    expect(resolved).toBe(entity);
  });
});
