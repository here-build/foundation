import { describe, expect, it } from "vitest";
import { SchemeExact, SchemeInexact, makeNumber, parseNumber, rosettaNumbers, schemeNumbers } from "../numbers";

describe("ExactNumber", () => {
  it("creates integers", () => {
    const n = new SchemeExact(42n);
    expect(n.num).toBe(42n);
    expect(n.denom).toBe(1n);
    expect(n.isInteger).toBe(true);
    expect(n.isExact).toBe(true);
    expect(n.toString()).toBe("42");
  });

  it("creates and normalizes rationals", () => {
    const n = new SchemeExact(6n, 4n);
    expect(n.num).toBe(3n);
    expect(n.denom).toBe(2n);
    expect(n.isInteger).toBe(false);
    expect(n.toString()).toBe("3/2");
  });

  it("handles negative rationals", () => {
    const n = new SchemeExact(-6n, 4n);
    expect(n.num).toBe(-3n);
    expect(n.denom).toBe(2n);

    const n2 = new SchemeExact(6n, -4n);
    expect(n2.num).toBe(-3n);
    expect(n2.denom).toBe(2n);
  });

  it("performs exact arithmetic", () => {
    const a = new SchemeExact(1n, 2n);
    const b = new SchemeExact(1n, 3n);

    expect(a.add(b).toString()).toBe("5/6");
    expect(a.sub(b).toString()).toBe("1/6");
    expect(a.mul(b).toString()).toBe("1/6");
    expect(a.div(b).toString()).toBe("3/2");
  });

  it("has tower predicates", () => {
    const n = new SchemeExact(3n, 4n);
    expect(n.isInteger).toBe(false);
    expect(n.isRational).toBe(true);
    expect(n.isReal).toBe(true);
    expect(n.isComplex).toBe(true);
  });

  it("rounds to even on ties", () => {
    expect(new SchemeExact(5n, 2n).round().toString()).toBe("2"); // 2.5 → 2
    expect(new SchemeExact(7n, 2n).round().toString()).toBe("4"); // 3.5 → 4
    expect(new SchemeExact(-5n, 2n).round().toString()).toBe("-2"); // -2.5 → -2
  });
});

describe("InexactNumber", () => {
  it("creates reals", () => {
    const n = new SchemeInexact(3.14);
    expect(n.real).toBe(3.14);
    expect(n.imag).toBe(0);
    expect(n.isReal).toBe(true);
    expect(n.isExact).toBe(false);
  });

  it("creates complex", () => {
    const n = new SchemeInexact(3, 4);
    expect(n.real).toBe(3);
    expect(n.imag).toBe(4);
    expect(n.isReal).toBe(false);
    expect(n.magnitude).toBe(5);
  });

  it("performs complex arithmetic", () => {
    const a = new SchemeInexact(3, 4);
    const b = new SchemeInexact(1, 2);

    const sum = a.add(b);
    expect(sum.real).toBe(4);
    expect(sum.imag).toBe(6);

    const prod = a.mul(b);
    expect(prod.real).toBe(-5); // 3*1 - 4*2
    expect(prod.imag).toBe(10); // 3*2 + 4*1
  });

  it("has tower predicates", () => {
    const real = new SchemeInexact(3.0);
    expect(real.isInteger).toBe(true);
    expect(real.isRational).toBe(true); // R7RS: finite reals are rational
    expect(real.isReal).toBe(true);

    const complex = new SchemeInexact(3, 4);
    expect(complex.isReal).toBe(false);
    expect(complex.isComplex).toBe(true);
  });

  it("rounds to even on ties", () => {
    expect(new SchemeInexact(2.5).round().real).toBe(2);
    expect(new SchemeInexact(3.5).round().real).toBe(4);
    expect(new SchemeInexact(4.5).round().real).toBe(4);
  });

  it("handles special values", () => {
    expect(new SchemeInexact(Infinity).toString()).toBe("+inf.0");
    expect(new SchemeInexact(-Infinity).toString()).toBe("-inf.0");
    expect(new SchemeInexact(NaN).toString()).toBe("+nan.0");
  });
});

describe("NumberRegistry - Scheme mode", () => {
  const reg = schemeNumbers;

  it("keeps exact rationals", () => {
    const a = new SchemeExact(1n);
    const b = new SchemeExact(2n);
    const result = reg.div(a, b);
    expect(result).toBeInstanceOf(SchemeExact);
    expect(result.toString()).toBe("1/2");
  });

  it("produces complex from sqrt of negative", () => {
    const n = new SchemeInexact(-4);
    const result = reg.sqrt(n);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).imag).toBe(2);
  });

  it("coerces exact + inexact → inexact", () => {
    const exact = new SchemeExact(1n, 2n);
    const inexact = new SchemeInexact(0.5);
    const result = reg.add(exact, inexact);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBe(1);
  });
});

describe("NumberRegistry - Rosetta mode", () => {
  const reg = rosettaNumbers;

  it("demotes rationals to inexact", () => {
    const a = new SchemeExact(1n);
    const b = new SchemeExact(2n);
    const result = reg.div(a, b);
    expect(result).toBeInstanceOf(SchemeInexact);
    expect((result as SchemeInexact).real).toBe(0.5);
  });

  it("throws on sqrt of negative", () => {
    const n = new SchemeInexact(-4);
    expect(() => reg.sqrt(n)).toThrow("complex");
  });

  it("throws on complex creation", () => {
    expect(() => reg.fromComplex(3, 4)).toThrow("Complex");
  });
});

describe("parseNumber", () => {
  it("parses integers", () => {
    const n = parseNumber("42");
    expect(n).toBeInstanceOf(SchemeExact);
    expect(n.toString()).toBe("42");
  });

  it("parses rationals", () => {
    const n = parseNumber("3/4");
    expect(n).toBeInstanceOf(SchemeExact);
    expect(n.toString()).toBe("3/4");
  });

  it("parses floats", () => {
    const n = parseNumber("3.14");
    expect(n).toBeInstanceOf(SchemeInexact);
    expect((n as SchemeInexact).real).toBeCloseTo(3.14);
  });

  it("parses special values", () => {
    expect(parseNumber("+inf.0").toString()).toBe("+inf.0");
    expect(parseNumber("-inf.0").toString()).toBe("-inf.0");
    expect(parseNumber("+nan.0").isNaN).toBe(true);
  });

  it("handles exactness prefixes", () => {
    const inexact = parseNumber("#i42");
    expect(inexact).toBeInstanceOf(SchemeInexact);
    expect(inexact.toString()).toBe("42.0");

    const exact = parseNumber("#e3.0");
    expect(exact).toBeInstanceOf(SchemeExact);
    expect(exact.isInteger).toBe(true);
  });

  it("handles radix prefixes", () => {
    expect(parseNumber("#xff").toString()).toBe("255");
    expect(parseNumber("#b1010").toString()).toBe("10");
    expect(parseNumber("#o77").toString()).toBe("63");
  });
});

describe("makeNumber", () => {
  it("creates from bigint", () => {
    const n = makeNumber(42n);
    expect(n).toBeInstanceOf(SchemeExact);
    expect((n as SchemeExact).num).toBe(42n);
  });

  it("creates from safe integer", () => {
    const n = makeNumber(42);
    expect(n).toBeInstanceOf(SchemeExact);
  });

  it("creates from float", () => {
    const n = makeNumber(3.14);
    expect(n).toBeInstanceOf(SchemeInexact);
  });

  it("passes through existing numbers", () => {
    const exact = new SchemeExact(42n);
    expect(makeNumber(exact)).toBe(exact);

    const inexact = new SchemeInexact(3.14);
    expect(makeNumber(inexact)).toBe(inexact);
  });
});
