/**
 * The pure namer functions. `cleanName` is the position-independent base; the
 * `nameCandidates` ladder adds the `is<Symbol>` predicate rung a scope-aware
 * collision resolver (#76) walks before postfixing — see lexical-js-naming.md.
 */
import { describe, expect, it } from "vitest";
import { cleanName, nameCandidates } from "../names.js";

describe("cleanName — base tier", () => {
  it("kebab → camel, drops predicate ?, lowers ->", () => {
    expect(cleanName("run-predict")).toBe("runPredict");
    expect(cleanName("dominates?")).toBe("dominates");
    expect(cleanName("string->list")).toBe("stringToList");
    expect(cleanName("set-x!")).toBe("setX");
  });

  it("escapes a JS reserved word", () => {
    expect(cleanName("new")).toBe("new_");
    expect(cleanName("class")).toBe("class_");
  });
});

describe("nameCandidates — the friendly ladder", () => {
  it("a predicate offers `foo` then `isFoo`", () => {
    expect(nameCandidates("picked?")).toEqual(["picked", "isPicked"]);
    expect(nameCandidates("dominates?")).toEqual(["dominates", "isDominates"]);
    expect(nameCandidates("complementary?")).toEqual(["complementary", "isComplementary"]);
  });

  it("a non-predicate offers just the base", () => {
    expect(nameCandidates("frontier")).toEqual(["frontier"]);
    expect(nameCandidates("run-predict")).toEqual(["runPredict"]);
  });

  it("a base that already reads as boolean is not double-prefixed", () => {
    expect(nameCandidates("is-empty?")).toEqual(["isEmpty"]);
    expect(nameCandidates("has-children?")).toEqual(["hasChildren"]);
    expect(nameCandidates("can-merge?")).toEqual(["canMerge"]);
  });
});
