import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { ArrivalCache, InferenceCache } from "../cache.js";
import { Project } from "../project.js";
import { InferenceResult } from "../task.js";

const seed = (cache: InferenceCache, m: string, p: string, valueJson: string) => {
  cache.upsertTask(m, p, null).result = new InferenceResult({ valueJson });
};

describe("require — Plexus VFS preamble", () => {
  it("inlines a .scm file so its defines are visible to the caller", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("_lib.scm", `(define (greet who) (string-append "hi " who))`);

    const value = await project.run(`
      (require "_lib.scm")
      (greet "world")
    `);

    expect(value).toBe("hi world");
  });

  it("binds a .txt file as a string identifier (filename minus extension)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("greeting.txt", "hello from txt");

    const value = await project.run(`
      (define greeting (require "greeting.txt"))
      greeting
    `);

    expect(value).toBe("hello from txt");
  });

  it("binds a .json file as a JS object — access via @ or :key", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("config.json", `{"answer": 42, "ok": true}`);

    const value = await project.run(`
      (define config (require "config.json"))
      (@ config "answer")
    `);

    expect(value).toBe(42);
  });

  it("threads required helpers into an infer call", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("_prompts.scm", `(define (greet-prompt who) (string-append "Greet " who))`);
    seed(cache, "fast", "Greet world", '"hi"');

    const value = await project.run(`
      (require "_prompts.scm")
      (car (infer "fast" (greet-prompt "world")))
    `);

    expect(value).toBe("hi");
  });

  it("expands transitive requires once (dedup)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("_base.scm", `(define base 1)`);
    project.addFile("_mid.scm", `(require "_base.scm") (define mid (+ base 1))`);

    const value = await project.run(`
      (require "_base.scm")
      (require "_mid.scm")
      (+ base mid)
    `);

    expect(value).toBe(3); // 1 + 2; if _base were inlined twice, the second define would be a re-bind (no-op here) but more concerning, transitive ordering would break
  });

  it("ignores (require …) tokens in comments and strings — not real requires", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // A real-world library that documents its own usage in a header comment and
    // mentions a require inside a string. Neither is a real require; the naive
    // regex used to match them → false `_lib.scm → _lib.scm` self-cycle.
    project.addFile(
      "_lib.scm",
      [
        `;; Shared helpers. Load with: (require "_lib.scm")`,
        `(define note "to import, write (require \\"_lib.scm\\")")`,
        `(define (greet who) (string-append "hi " who))`,
      ].join("\n"),
    );

    const value = await project.run(`
      (require "_lib.scm")
      (greet "world")
    `);
    expect(value).toBe("hi world");
  });

  it("ignores a (require …) inside a block comment", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("_b.scm", `#| example: (require "_b.scm") |# (define x 7)`);
    const value = await project.run(`(require "_b.scm") x`);
    expect(value).toBe(7);
  });

  it("throws on a cyclic require", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("a.scm", `(require "b.scm")`);
    project.addFile("b.scm", `(require "a.scm")`);

    await expect(project.run(`(require "a.scm")`)).rejects.toThrow(/cyclic/);
  });

  it("a parallel (map (require …)) over the same VALUE leaf dedups, not a false cycle", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("d.json", `{"n": 7}`);
    // `map` evaluates its body in parallel (promise_all), so the three requires of
    // d.json fire concurrently. The old flat in-flight Set read siblings #2 and #3
    // as `d.json → d.json` cycles; single-flight dedups them onto one load.
    const value = await project.run(`(apply + (map (lambda (x) (:n (require "d.json"))) (list 1 2 3)))`);
    expect(value).toBe(21); // 7 × 3 — all three siblings resolved, none threw
  });

  it("a parallel (map (require …)) over the same EVAL leaf dedups (the react.prompt shape)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("t.hbs", `hi {{who}}`);
    // `.hbs`/`.prompt` are eval-kind leaves — exactly the class that fanned out as
    // `(map (require "react.prompt") …)` and spuriously cycled. Loading is what
    // races (not calling), so concurrently requiring the render lambda is enough.
    const value = await project.run(`(length (map (lambda (x) (require "t.hbs")) (list 1 2 3)))`);
    expect(value).toBe(3);
  });

  it("throws when the file isn't in the project", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    await expect(project.run(`(require "missing.scm")`)).rejects.toThrow(/not found/);
  });

  it("parses .yaml and binds the value", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile(
      "config.yaml",
      ["name: maya", "scores:", "  - 10", "  - 20", "  - 30"].join("\n"),
    );

    const value = await project.run(`(define config (require "config.yaml")) (:name config)`);
    expect(value).toBe("maya");
  });

  it("parses .toml and binds the value", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile(
      "config.toml",
      ['name = "priya"', "scores = [1, 2, 3]"].join("\n"),
    );

    const value = await project.run(`(define config (require "config.toml")) (:name config)`);
    expect(value).toBe("priya");
  });

  it("parses .ndjson and binds an array of records", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile(
      "people.ndjson",
      ['{"id":1,"name":"a"}', '{"id":2,"name":"b"}', '{"id":3,"name":"c"}'].join("\n"),
    );

    const value = await project.run(`(define people (require "people.ndjson")) (length people)`);
    expect(value).toBe(3);
  });

  it("a data require RETURNS its value and does NOT spill a filename-global", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    project.addFile("data.json", JSON.stringify({ x: 7 }));

    // Explicit binding works — require returns the value.
    expect(await project.run(`(define d (require "data.json")) (:x d)`)).toBe(7);
    // But a bare require binds nothing: referencing the old filename-global throws.
    await expect(project.run(`(require "data.json") (:x data)`)).rejects.toThrow();
  });

  it("makes a define-macro from a required file available to the caller", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // A library's `define-macro` must be installed before the CALLER's next form
    // expands. `require` is eager-sequential (the macro spills during the require
    // form) and macro expansion is at eval time — so by the time `(when …)`
    // evaluates, `when` is already a macro in env. This is the core property the
    // runtime-load redesign must preserve (the old textual splice got it for free
    // via source ordering; runtime require earns it via eager-sequential eval).
    project.addFile("_macros.scm", "(define-macro (when test . body) `(if ,test (begin ,@body)))");

    const value = await project.run(`
      (require "_macros.scm")
      (when #t 1 2 3)
    `);
    expect(value).toBe(3);
  });

  it("annotates a throw inside a required module with the require chain", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // a requires b; b throws (unbound variable). The error carries the chain of
    // files loading when it threw — the deepest require wins, so the chain reads
    // entry → failing module. (L3 stacktraces: this is the "which require led
    // here" half; file:line within a module is the complementary half.)
    project.addFile("a.scm", `(require "b.scm")`);
    project.addFile("b.scm", `boom-unbound-variable`);

    let err: unknown;
    try {
      await project.run(`(require "a.scm")`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { requireChain?: string[] }).requireChain).toEqual(["a.scm", "b.scm"]);
  });

  it("tags a required module's frames with its file path (file:line in the scheme stack)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    const cache = ArrivalCache.bootstrap(new InferenceCache()).root;
    project.bindCache(cache);
    // A require-time throw via a USER-function call located in the module: only
    // user-function calls push a frame (builtins like `car` are leaf ops), so the
    // `(boom)` call — located in util.scm via the `source` threaded through parse —
    // is what's captured (car's typecheck throws inside, TCO-folded into boom's
    // frame). The rendered SchemeError stack reads `util.scm:line`.
    project.addFile("util.scm", `(define (boom) (car 5)) (boom)`);

    let err: unknown;
    try {
      await project.run(`(require "util.scm")`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toContain("util.scm");
  });
});
