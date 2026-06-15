/**
 * Provenance soundness for the value-COLLAPSING ops (string-append / join).
 *
 * Collapsing a structure of inference-stamped values into one flat string destroys
 * the members the trace would walk; `collapseProvenance` must deep-walk and hoist
 * EVERY reachable point so field-to-field wiring survives the collapse. A gap here
 * is a SILENT provenance hole (no error, just a missing edge), so each structured
 * carrier gets a pin. See provenance-collapse.ts.
 */

import { describe, it, expect } from "vitest";
import { collapseProvenance } from "../provenance-collapse";
import { initBridge } from "../bridge";
import { exec } from "../stdlib";
import { sandboxedEnv } from "../sandbox-env";
import { SchemeString } from "../SchemeString";
import { SchemeVector } from "../SchemeVector";
import { Pair } from "../Pair";
import { SchemeJSArray } from "../membrane";
import { nil } from "../types";

const stamped = (s: string, ...points: number[]) => new SchemeString(s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

describe("collapseProvenance — sound over every structured carrier", () => {
  it("collects a bare AValue's own points", () => {
    expect(sorted(collapseProvenance(stamped("a", 1, 2)))).toEqual([1, 2]);
  });

  it("deep-walks a Pair list spine", () => {
    const list = new Pair(stamped("a", 1), new Pair(stamped("b", 2), nil));
    expect(sorted(collapseProvenance(list))).toEqual([1, 2]);
  });

  it("deep-walks a SchemeVector's elements (the gap a flat union missed)", () => {
    const vec = new SchemeVector([stamped("a", 1), stamped("b", 2)]);
    expect(sorted(collapseProvenance(vec))).toEqual([1, 2]);
  });

  it("deep-walks a SchemeJSArray's source (the wrapper is not an AValue)", () => {
    const arr = new SchemeJSArray([stamped("a", 1), stamped("b", 2)]);
    expect(sorted(collapseProvenance(arr))).toEqual([1, 2]);
  });

  it("deep-walks a raw JS array", () => {
    expect(sorted(collapseProvenance([stamped("a", 1), stamped("b", 2)]))).toEqual([1, 2]);
  });

  it("unions across multiple args and nested structures", () => {
    const nested = new Pair(stamped("a", 1), new Pair(new SchemeVector([stamped("b", 2)]), nil));
    expect(sorted(collapseProvenance(stamped("sep", 9), nested))).toEqual([1, 2, 9]);
  });

  it("is idempotent (never mints fresh ids) and cycle-safe", () => {
    expect(sorted(collapseProvenance(stamped("a", 1), stamped("a", 1)))).toEqual([1]);
    const cyclic: unknown[] = [stamped("a", 1)];
    cyclic.push(cyclic); // self-reference — the occurs-check must not loop
    expect(sorted(collapseProvenance(cyclic))).toEqual([1]);
  });
});

describe("string-append / join carry deep collapse-provenance end-to-end", () => {
  it("join over a list of stamped values keeps every point", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("collapse-prov-join");
    env.set("a", stamped("alpha", 1));
    env.set("b", stamped("beta", 2));
    const [r] = await exec(`(join "," (list a b))`, { env });
    expect(r).toBeInstanceOf(SchemeString);
    expect(sorted((r as SchemeString).provenance as Set<number>)).toEqual([1, 2]);
  });

  it("string-append over a nested collapse keeps every point", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("collapse-prov-append");
    env.set("a", stamped("alpha", 1));
    env.set("b", stamped("beta", 2));
    const [r] = await exec(`(string-append "x:" (join "," (list a b)))`, { env });
    expect(r).toBeInstanceOf(SchemeString);
    expect(sorted((r as SchemeString).provenance as Set<number>)).toEqual([1, 2]);
  });
});
