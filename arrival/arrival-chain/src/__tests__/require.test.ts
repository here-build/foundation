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
      (require "greeting.txt")
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
      (require "config.json")
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

    const value = await project.run(`(require "config.yaml") (field config "name")`);
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

    const value = await project.run(`(require "config.toml") (field config "name")`);
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

    const value = await project.run(`(require "people.ndjson") (length people)`);
    expect(value).toBe(3);
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
});
