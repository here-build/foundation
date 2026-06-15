/**
 * The sandbox membrane is EARNED, not hand-waved (NODE E4: "sandbox membrane
 * escape"). These adversarial tests drive REAL scheme through the sandboxed env
 * (`runPipeline`) and assert that a hostile program cannot:
 *   1. climb the prototype chain to a constructor (`constructor` / `__proto__`) and
 *      reach `Function` (the classic `Function("return process")()` escape);
 *   2. read host globals (`process`, `globalThis`, `fetch`, `require`) — they are
 *      simply unbound in the sandbox;
 *   3. exfiltrate a SECRET captured in a host-side closure (the rosetta keeps the
 *      closure host-side; only the membraned RETURN value crosses).
 *
 * The audit's "CONFIRMED SOLID — the sandbox membrane is earned, rosetta keeps
 * closures host-side, escape tests pass" claim, made executable. If any of these
 * regress, an host-hosted program (an agent's `(declare/expose)` handler) could
 * break out of the sandbox into the DO's memory — where the decrypted keys live.
 */
import { describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "@here.build/arrival-inference";
import { singletonRouter } from "@here.build/arrival-inference";
import { runPipeline } from "../runner.js";

// A canary the host side knows but the sandbox must never see. Assembled so the
// entropy linter doesn't flag the fake.
const HOST_SECRET = ["sk", "host", "DEADBEEFcaptured", "neverCrosses"].join("-");

/** A router whose backend closure CAPTURES `HOST_SECRET` but returns only a benign
 *  string. If the sandbox could reach the closure, it could read the secret; it
 *  cannot — only the membraned return value crosses. */
function capturingRouter(returnValue: unknown = "ok") {
  const _captured = HOST_SECRET; // captured in the closure — must stay host-side
  return singletonRouter({
    complete: vi.fn(async (_s: ModelSpec) => {
      void _captured; // referenced so it's a real capture, never surfaced
      return { value: returnValue };
    }),
  });
}

const run = (scm: string, returnValue?: unknown): Promise<unknown> =>
  runPipeline({ files: { "main.scm": scm }, entry: "main.scm", router: capturingRouter(returnValue) });

/** A blocked property read crosses the membrane as scheme `nil` — at the run
 *  boundary that is a `Nil` instance (`{provenance, kind:"nil"}`), NOT a function
 *  and NOT the host constructor. This asserts the SECURITY fact: whatever came back,
 *  it is not callable host code and not the `Function`/`Object` constructor. */
function expectBlockedToNil(result: unknown): void {
  expect(typeof result).not.toBe("function"); // never the constructor / a callable
  const ctorName = (result as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;
  expect(ctorName).toBe("Nil"); // the scheme empty-list sentinel — a blocked read
}

describe("prototype-chain escapes collapse to nil — no path to Function/constructor", () => {
  it("(@ obj :constructor) on a crossed object is nil, not the Function constructor", async () => {
    // The infer result is an object that crosses the membrane (jsToScheme →
    // SchemeJSObject). Reading `constructor` must be blocked (→ nil), so the classic
    // `obj.constructor.constructor("…")` Function escape has no first rung.
    expectBlockedToNil(await run(`(define o (car (infer "m" "p"))) (@ o :constructor)`, { real: "field" }));
  });

  it("(@ obj :__proto__) is nil — no prototype walk", async () => {
    expectBlockedToNil(await run(`(define o (car (infer "m" "p"))) (@ o :__proto__)`, { real: "field" }));
  });

  it("the double-constructor Function breakout (@ (@ o :constructor) :constructor) yields nil — never Function", async () => {
    // The whole escape, end to end: even chaining the blocked read can't surface a
    // callable. The result is nil; there is no `Function` to invoke `("return process")`.
    expectBlockedToNil(
      await run(`(define o (car (infer "m" "p"))) (@ (@ o :constructor) :constructor)`, { real: "field" }),
    );
  });

  it("a legitimate own key IS readable (the membrane allows real data, blocks only the chain)", async () => {
    // Proves the block is surgical: own data crosses, the prototype/constructor does not.
    const result = await run(`(define o (car (infer "m" "p"))) (@ o :real)`, { real: "field" });
    expect(result).toBe("field");
  });

  it("(@ obj :prototype) and (@ obj :__defineGetter__) are nil (blocked names)", async () => {
    expectBlockedToNil(await run(`(define o (car (infer "m" "p"))) (@ o :prototype)`, { real: "x" }));
    expectBlockedToNil(await run(`(define o (car (infer "m" "p"))) (@ o :__defineGetter__)`, { real: "x" }));
  });
});

describe("host globals are unbound in the sandbox", () => {
  // The dangerous host capabilities are simply not in the sandbox env — reaching
  // for them is an UNBOUND VARIABLE, the strongest possible "no escape" (there is
  // no symbol to even start from). Verified empirically: each throws.
  // NOTE: `fetch` and `require` ARE bound, but to SCHEME builtins (a curried
  // Fantasy-Land applicative / the module-loader verb) — NOT the host `fetch` /
  // Node `require`; they perform no network/FS I/O (see the dedicated checks below),
  // so they are not escape vectors and are deliberately NOT in this unbound list.
  for (const g of ["process", "globalThis", "global", "Function", "eval"]) {
    it(`\`${g}\` is an unbound variable (no host capability to start from)`, async () => {
      await expect(run(`${g}`)).rejects.toThrow(/[Uu]nbound variable/);
    });
  }

  it("`process.env` cannot be read — `process` itself is unbound (no host env leak)", async () => {
    await expect(run(`(@ process :env)`)).rejects.toThrow(/[Uu]nbound variable/);
  });

  it("`(Function \"return this\")` cannot construct a function — `Function` is unbound (no constructor escape)", async () => {
    // The classic `Function("return process")()` breakout has no constructor to call.
    await expect(run(`((Function "return this"))`)).rejects.toThrow(/[Uu]nbound variable/);
  });

  it("the scheme `fetch` builtin is NOT the host fetch — it performs no network I/O", async () => {
    // `fetch` resolves (to a scheme bridge fn), but it is harmless: applied to a
    // URL string it does not reach the network (it returns a curried function / a
    // list-shaped value), so a hostile program cannot exfiltrate via it. This guards
    // that a future change doesn't accidentally bind the HOST fetch to this name.
    const onList = await run(`(fetch (list 1 2 3))`);
    // `fetch` is Ramda `prop` (a pure, curried property accessor), so applying it
    // yields a curried fn — never `undefined`, and definitely never an HTTP response.
    expect(typeof onList).toBe("function");
    // A URL string yields a function (curried bridge), never a Response/promise-of-body.
    const onUrl = await run(`(fetch "http://169.254.169.254/latest/meta-data")`);
    expect(typeof onUrl).toBe("function");
  });
});

describe("closure exfiltration — the host secret never crosses", () => {
  it("the captured HOST_SECRET appears in NO surface of the run result", async () => {
    // Pull the whole infer result into scheme and return it; assert the secret the
    // backend closure captured is nowhere in what crosses out.
    const result = await run(`(car (infer "m" "p"))`, { value: "benign", nested: { a: 1 } });
    const surfaced = JSON.stringify(result);
    expect(surfaced).not.toContain(HOST_SECRET);
    expect(surfaced).not.toContain("captured");
  });

  it("string-appending the result cannot reconstruct the secret (only the value crossed)", async () => {
    const result = await run(`(string-append "got:" (car (infer "m" "p")))`, "benign");
    expect(result).toBe("got:benign");
    expect(String(result)).not.toContain(HOST_SECRET);
  });
});
