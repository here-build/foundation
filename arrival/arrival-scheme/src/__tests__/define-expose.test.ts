// ADR-022: `define/expose` is an evaluator-transparent authoring superset that
// binds identically to `define`, plus a host-side analysis pass (`scanExposed`)
// that reads the export annotation off parsed forms. These verdict tests prove:
//   (a) define/expose binds identically to define (same callable, same value)
//   (b) scanExposed produces an ExportRecord with the derived token
//   (c) a define/expose program runs identically to its define twin (evaluator
//       unchanged — the dataflow core never sees the annotation)
import { describe, expect, it } from "vitest";
import { initBridge } from "../bridge.js";
import { scanExposed, deriveToken } from "../exposed.js";
import { env, exec, parse } from "../stdlib.js";

await initBridge();

const run = async (form: string) => (await exec(form, env)) as unknown[];
const last = async (form: string) => String((await run(form)).at(-1));

describe("define/expose binds identically to define", () => {
  it("binds a value that is callable and equal to the define twin", async () => {
    const defineProg = "(define (sq x) (* x x)) (sq 7)";
    const exposeProg = "(define/expose (sq x) (* x x)) (sq 7)";
    expect(await last(defineProg)).toBe("49");
    expect(await last(exposeProg)).toBe(await last(defineProg));
  });

  it("binds a plain value, not just a function", async () => {
    expect(await last("(define/expose answer 42) answer")).toBe("42");
  });

  it("strips a leading #:id annotation and still binds the value", async () => {
    expect(await last("(define/expose greeting #:id pub/greeting \"hi\") greeting")).toBe("hi");
  });

  it("the lexical name is freely usable by in-graph callers", async () => {
    expect(await last("(define/expose double (lambda (n) (+ n n))) (double (double 3))")).toBe("12");
  });
});

describe("scanExposed produces export-records with derived tokens", () => {
  it("derives a pub/ token from a kebabed name", () => {
    expect(deriveToken("runResearch")).toBe("pub/run-research");
    expect(deriveToken("run_research")).toBe("pub/run-research");
  });

  it("records name + token for a function-shorthand define/expose", async () => {
    const forms = await parse("(define/expose (runResearch x) (list x))");
    const records = scanExposed(forms);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: "runResearch", token: "pub/run-research" });
  });

  it("honors a frozen #:id token verbatim over derivation", async () => {
    const forms = await parse("(define/expose run #:id pub/kept-token (lambda () 1))");
    const records = scanExposed(forms);
    expect(records[0]).toMatchObject({ name: "run", token: "pub/kept-token" });
  });

  it("suffixes colliding derived tokens deterministically", async () => {
    const forms = await parse("(define/expose foo 1) (define/expose foo 2)");
    const records = scanExposed(forms);
    expect(records.map((r) => r.token)).toEqual(["pub/foo", "pub/foo-2"]);
  });

  it("ignores plain define (no record)", async () => {
    const forms = await parse("(define plain 1) (define/expose shown 2)");
    const records = scanExposed(forms);
    expect(records.map((r) => r.name)).toEqual(["shown"]);
  });

  it("is pure — same forms produce the same records", async () => {
    const forms = await parse("(define/expose a 1) (define/expose b 2)");
    expect(scanExposed(forms)).toEqual(scanExposed(forms));
  });
});

describe("evaluator is unchanged — define/expose program runs identically", () => {
  it("a multi-form program produces the same result sequence as its define twin", async () => {
    const defineProg = "(define x 10) (define (f n) (+ n x)) (f 5)";
    const exposeProg = "(define/expose x 10) (define/expose (f n) (+ n x)) (f 5)";
    const defineResults = (await run(defineProg)).map(String);
    const exposeResults = (await run(exposeProg)).map(String);
    expect(exposeResults).toEqual(defineResults);
  });
});
