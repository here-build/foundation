/**
 * Three call modes for hbs templates + structural validation errors.
 */
import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";
import { analyzeTemplate } from "../template-analyze.js";

const run = async (
  files: Record<string, string>,
  main: string,
): Promise<unknown> => {
  const project = ArrivalChain.bootstrap(new Project()).root;
  for (const [path, content] of Object.entries(files)) project.addFile(path, content);
  return await project.addProgram("main.scm", main).run();
};

describe("template analyzer", () => {
  it("collects single root field for {{phrase}}", () => {
    const info = analyzeTemplate("Hello {{phrase}}");
    expect(info.rootFields).toEqual(["phrase"]);
    expect(info.singleVarName).toBe("phrase");
  });

  it("walks nested paths into structure", () => {
    const info = analyzeTemplate("Hi {{user.name}} from {{user.city}}");
    expect(info.rootFields).toEqual(["user"]);
    expect(info.singleVarName).toBe("user");
    expect(info.shape.kind).toBe("object");
  });

  it("each block marks the path as array; inner fields live on element", () => {
    const info = analyzeTemplate("{{#each items}}- {{name}}\n{{/each}}");
    expect(info.rootFields).toEqual(["items"]);
    if (info.shape.kind !== "object") throw new Error("shape");
    const items = info.shape.fields.get("items")!;
    expect(items.kind).toBe("array");
  });

  it("multiple top-level fields → no singleVarName", () => {
    const info = analyzeTemplate("{{verb}} {{noun}}");
    expect(info.rootFields).toEqual(["verb", "noun"]);
    expect(info.singleVarName).toBeNull();
  });
});

describe("call modes", () => {
  it("single primitive + single-var template → wraps as {var: arg}", async () => {
    const r = await run(
      { "greet.hbs": "Hello {{name}}!" },
      `((require "greet.hbs") "world")`,
    );
    expect(r).toBe("Hello world!");
  });

  it("single dict arg passes through", async () => {
    const r = await run(
      { "greet.hbs": "Hello {{name}}!" },
      `((require "greet.hbs") (dict "name" "world"))`,
    );
    expect(r).toBe("Hello world!");
  });

  it("alternating string-key/value pairs build the dict", async () => {
    const r = await run(
      { "greet.hbs": "{{verb}} {{noun}}" },
      `((require "greet.hbs") "verb" "Hello" "noun" "world")`,
    );
    expect(r).toBe("Hello world");
  });

  it("array as single arg to single-var template → wrapped", async () => {
    const r = await run(
      { "render-items.hbs": "{{#each items}}{{this}};{{/each}}" },
      `((require "render-items.hbs") (list "a" "b" "c"))`,
    );
    expect(r).toBe("a;b;c;");
  });
});

describe("error messages", () => {
  it("single primitive to multi-var template throws with field names", async () => {
    await expect(
      run({ "two.hbs": "{{a}} {{b}}" }, `((require "two.hbs") "x")`),
    ).rejects.toThrow(/two fields|a, b|single primitive/);
  });

  it("dict missing required nested field throws with path", async () => {
    await expect(
      run(
        { "u.hbs": "Hi {{user.name}}" },
        `((require "u.hbs") (dict "user" (dict "city" "Paris")))`,
      ),
    ).rejects.toThrow(/user\.name is missing/);
  });

  it("each block requires array, dict input rejected", async () => {
    await expect(
      run(
        { "ls.hbs": "{{#each items}}-{{this}}{{/each}}" },
        `((require "ls.hbs") (dict "items" "not-an-array"))`,
      ),
    ).rejects.toThrow(/items.*expected array/);
  });

  it("odd number of args (not 1) → structured error", async () => {
    await expect(
      run({ "t.hbs": "{{a}} {{b}}" }, `((require "t.hbs") "a" "x" "b")`),
    ).rejects.toThrow(/even number of args/);
  });

  it("unknown keyword in KV-mode → throws with allowed fields", async () => {
    await expect(
      run({ "t.hbs": "{{a}}" }, `((require "t.hbs") "wrong-key" "x")`),
    ).rejects.toThrow(/unknown field "wrong-key"/);
  });
});
