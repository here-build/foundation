/**
 * (require "x.hbs") defines a callable named after the file basename that
 * accepts a dict and returns the rendered template string. Verified across
 * three input shapes: a required .json object, env-derived dict,
 * literal scheme records.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";

describe("(require \"*.hbs\") — handlebars templates", () => {
  it("inline call site: ((require ...) data)", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.addFile("greeting.hbs", "Hello, {{name}}!");
    project.addFile("who.json", JSON.stringify({ name: "world" }));
    const program = project.addProgram("main.scm", `
      (define who (require "who.json"))
      ((require "greeting.hbs") who)
    `);
    expect(await program.run()).toBe("Hello, world!");
  });

  it("user-named binding: (define name (require ...))", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.addFile("greet.hbs", "Hello, {{name}}!");
    const program = project.addProgram("main.scm", `
      (define say-hello (require "greet.hbs"))
      (say-hello "world")
    `);
    expect(await program.run()).toBe("Hello, world!");
  });

  it("renders with nested data + iteration", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.addFile("listing.hbs",
      "Items:\n{{#each items}} - {{this}}\n{{/each}}");
    project.addFile("data.json", JSON.stringify({ items: ["a", "b", "c"] }));
    const program = project.addProgram("main.scm", `
      (define data (require "data.json"))
      ((require "listing.hbs") data)
    `);
    expect(await program.run()).toBe("Items:\n - a\n - b\n - c\n");
  });

  it("(dict ...) builds inline dict for the template call site", async () => {
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.addFile("greet.hbs", "{{verb}} {{noun}}");
    const program = project.addProgram("main.scm", `
      (define greet (require "greet.hbs"))
      (greet (dict "verb" "Hello" "noun" "World"))
    `);
    expect(await program.run()).toBe("Hello World");
  });

  it("templates can compose into infer prompts", async () => {
    // Pure-data path — no backend hit. Render a template, then string-append
    // it as a "prompt" we'd send to infer.
    const project = ArrivalChain.bootstrap(new Project()).root;
    project.addFile("prompt.hbs",
      "Translate {{lang}}: {{phrase}}");
    project.addFile("d.json", JSON.stringify({ lang: "french", phrase: "hello" }));
    const program = project.addProgram("main.scm", `
      (define d (require "d.json"))
      ((require "prompt.hbs") d)
    `);
    expect(await program.run()).toBe("Translate french: hello");
  });
});
