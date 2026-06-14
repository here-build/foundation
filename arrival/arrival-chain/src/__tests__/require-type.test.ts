// require-type.test.ts — the EDITOR twin of the require registry: a single
// extension registration teaches BOTH the runtime parse (`resolve`) and the
// lens shape (`type`). Pure synthesis, no LLM, no worker — just the loader.

import { describe, expect, it } from "vitest";

import {
  defaultResolvers,
  loaderFromResolver,
  resolveRequireType,
  valueToTsType,
  type ExtensionHandler,
  type Loader,
} from "../loader.js";

describe("valueToTsType — JS value → lens TS type", () => {
  it("maps scalars to the branded base types", () => {
    expect(valueToTsType("x")).toBe("SStr");
    expect(valueToTsType(3)).toBe("SNum");
    expect(valueToTsType(true)).toBe("SBool");
    expect(valueToTsType(null)).toBe("null");
  });

  it("maps a plain object to an accessible record (quoted keys, recursive)", () => {
    expect(valueToTsType({ name: "a", age: 30 })).toBe(`{ "name": SStr; "age": SNum }`);
    expect(valueToTsType({ user: { id: 1 } })).toBe(`{ "user": { "id": SNum } }`);
  });

  it("maps an array to List<T> with a deduped element union", () => {
    expect(valueToTsType([1, 2, 3])).toBe("List<SNum>");
    expect(valueToTsType([{ name: "a", age: 1 }])).toBe(`List<{ "name": SStr; "age": SNum }>`);
    expect(valueToTsType([1, "x"])).toBe("List<(SNum | SStr)>");
    expect(valueToTsType([])).toBe("List<unknown>");
  });
});

describe("resolveRequireType — route a file's source through the registry", () => {
  const loader: Loader = loaderFromResolver(() => {
    throw new Error("read not used in type synthesis");
  });

  it("synthesizes the granular shape for a .json data file", () => {
    const ts = resolveRequireType(loader, "personas.json", `[{"name":"a","age":30}]`);
    expect(ts).toBe(`List<{ "name": SStr; "age": SNum }>`);
  });

  it(".txt is a string; .scm (no type provider) and unknown extensions are null", () => {
    expect(resolveRequireType(loader, "notes.txt", "hello")).toBe("SStr");
    expect(resolveRequireType(loader, "lib.scm", "(define x 1)")).toBeNull();
    expect(resolveRequireType(loader, "thing.bin", "...")).toBeNull();
  });

  it("a malformed data file degrades to null (lens falls back to unknown)", () => {
    expect(resolveRequireType(loader, "broken.json", "{not json")).toBeNull();
  });

  it("a custom extension registered with a `type` provider is reachable", () => {
    const custom: ExtensionHandler = {
      resolve: (contents) => ({ kind: "value", value: String(contents) }),
      type: () => `{ "csv": List<SStr> }`,
    };
    const customLoader: Loader = {
      ...loader,
      resolvers: new Map(defaultResolvers()).set(".csv", custom),
    };
    expect(resolveRequireType(customLoader, "rows.csv", "a,b\n1,2")).toBe(`{ "csv": List<SStr> }`);
  });
});
