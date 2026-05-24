/**
 * Unit tests for the path cache (step 4 of lineage impl).
 *
 * Two surfaces under test:
 *   - serializePrefix: deterministic encoding of DNFPath into a cache key
 *   - createPathCache: get / set / clear / size + LRU eviction
 *   - bindCacheToProjectEnv: mobx-reaction clears cache on env mutation
 *
 * No interpreter, no I/O — pure data + mobx reactions.
 */
import "@here.build/plexus/mobx/register";
import { runInAction } from "mobx";
import { describe, expect, it } from "vitest";

import {
  bindCacheToProjectEnv,
  createPathCache,
  serializePrefix,
  type DNFPath,
  type PathCache,
} from "../lineage.js";
import { Project } from "../project.js";

const refAt = (line: number, col: number) => ({ programHash: "p", line, col });

const branchPath = (arm: number): DNFPath => [
  { kind: "branch", point: refAt(3, 4), arm },
];

const iteratePath = (idx: number): DNFPath => [
  { kind: "iterate", point: refAt(7, 2), index: idx },
];

const mixedPath = (): DNFPath => [
  { kind: "iterate", point: refAt(7, 2), index: 0 },
  { kind: "branch",  point: refAt(3, 4), arm: 1 },
];

describe("serializePrefix", () => {
  it("returns the same string for the same prefix", () => {
    expect(serializePrefix(branchPath(0))).toBe(serializePrefix(branchPath(0)));
  });

  it("distinguishes prefixes by arm", () => {
    expect(serializePrefix(branchPath(0))).not.toBe(serializePrefix(branchPath(1)));
  });

  it("distinguishes prefixes by kind even when point + numeric field collide", () => {
    // branch arm=2 vs iterate index=2 at the same point should differ
    const branch: DNFPath = [{ kind: "branch", point: refAt(1, 1), arm: 2 }];
    const iterate: DNFPath = [{ kind: "iterate", point: refAt(1, 1), index: 2 }];
    expect(serializePrefix(branch)).not.toBe(serializePrefix(iterate));
  });

  it("encodes order — reordered entries produce a different key", () => {
    const ab: DNFPath = [
      { kind: "branch",  point: refAt(1, 1), arm: 0 },
      { kind: "iterate", point: refAt(2, 2), index: 0 },
    ];
    const ba: DNFPath = [ab[1]!, ab[0]!];
    expect(serializePrefix(ab)).not.toBe(serializePrefix(ba));
  });

  it("returns an empty string for an empty prefix", () => {
    expect(serializePrefix([])).toBe("");
  });
});

describe("createPathCache", () => {
  const entry = (v: unknown) => ({ value: v, tasksCreated: [] as readonly string[] });

  it("returns undefined for an unseen prefix", () => {
    const cache: PathCache = createPathCache();
    expect(cache.get(branchPath(0))).toBeUndefined();
  });

  it("returns a stored entry on get", () => {
    const cache: PathCache = createPathCache();
    cache.set(branchPath(0), entry("hello"));
    expect(cache.get(branchPath(0))).toEqual(entry("hello"));
  });

  it("distinguishes by prefix kind / fields", () => {
    const cache: PathCache = createPathCache();
    cache.set(branchPath(0), entry("alice"));
    cache.set(branchPath(1), entry("bob"));
    cache.set(iteratePath(0), entry("first"));
    expect(cache.get(branchPath(0))?.value).toBe("alice");
    expect(cache.get(branchPath(1))?.value).toBe("bob");
    expect(cache.get(iteratePath(0))?.value).toBe("first");
  });

  it("overwrites on repeat set", () => {
    const cache: PathCache = createPathCache();
    cache.set(branchPath(0), entry("v1"));
    cache.set(branchPath(0), entry("v2"));
    expect(cache.get(branchPath(0))?.value).toBe("v2");
    expect(cache.size()).toBe(1);
  });

  it("size() reflects the number of stored entries", () => {
    const cache: PathCache = createPathCache();
    expect(cache.size()).toBe(0);
    cache.set(branchPath(0), entry(1));
    expect(cache.size()).toBe(1);
    cache.set(branchPath(1), entry(2));
    cache.set(iteratePath(0), entry(3));
    expect(cache.size()).toBe(3);
  });

  it("clear() drops all entries", () => {
    const cache: PathCache = createPathCache();
    cache.set(branchPath(0), entry(1));
    cache.set(mixedPath(), entry(2));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get(branchPath(0))).toBeUndefined();
  });

  it("evicts the oldest entry past capacity (LRU)", () => {
    const cache = createPathCache(2);
    cache.set(branchPath(0), entry("a"));
    cache.set(branchPath(1), entry("b"));
    cache.set(iteratePath(0), entry("c"));
    expect(cache.size()).toBe(2);
    // branchPath(0) is the oldest, should be evicted
    expect(cache.get(branchPath(0))).toBeUndefined();
    expect(cache.get(branchPath(1))?.value).toBe("b");
    expect(cache.get(iteratePath(0))?.value).toBe("c");
  });

  it("LRU promotes on hit — a recently-read entry survives subsequent inserts", () => {
    const cache = createPathCache(2);
    cache.set(branchPath(0), entry("a"));
    cache.set(branchPath(1), entry("b"));
    // touch a — it should now be MRU
    expect(cache.get(branchPath(0))?.value).toBe("a");
    // inserting c should evict b (the now-oldest), not a
    cache.set(iteratePath(0), entry("c"));
    expect(cache.get(branchPath(0))?.value).toBe("a");
    expect(cache.get(branchPath(1))).toBeUndefined();
    expect(cache.get(iteratePath(0))?.value).toBe("c");
  });
});

describe("bindCacheToProjectEnv", () => {
  it("clears the cache when project.env mutates", () => {
    const cache = createPathCache();
    cache.set(branchPath(0), { value: "warm", tasksCreated: [] });

    const project = new Project();
    const dispose = bindCacheToProjectEnv(cache, project);

    expect(cache.size()).toBe(1);
    runInAction(() => project.setEnv("mood", "happy"));
    expect(cache.size()).toBe(0);

    dispose();
  });

  it("does not fire on the same env state set twice (envHash unchanged)", () => {
    const cache = createPathCache();

    const project = new Project();
    runInAction(() => project.setEnv("mood", "happy"));

    cache.set(branchPath(0), { value: "warm", tasksCreated: [] });
    const dispose = bindCacheToProjectEnv(cache, project);

    // Setting the same key to the same value: envHash is identical;
    // reaction should not fire and the cache should persist.
    runInAction(() => project.setEnv("mood", "happy"));
    expect(cache.size()).toBe(1);

    dispose();
  });

  it("dispose() detaches the reaction — subsequent env changes don't clear", () => {
    const cache = createPathCache();
    cache.set(branchPath(0), { value: "warm", tasksCreated: [] });

    const project = new Project();
    const dispose = bindCacheToProjectEnv(cache, project);
    dispose();

    runInAction(() => project.setEnv("mood", "anything"));
    expect(cache.size()).toBe(1);
  });
});
