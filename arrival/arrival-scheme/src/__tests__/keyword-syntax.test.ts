/**
 * Test whether LIPS supports :keyword syntax
 */

import { describe, expect, it } from "vitest";
import { exec } from "../lips";
import { sandboxedEnv } from "../sandbox-env";
import { lipsToJs } from "../rosetta";

async function execOne(expr: string, env = sandboxedEnv): Promise<any> {
  const results = await exec(expr, { env });
  return results[0];
}

describe("LIPS Keyword Syntax Investigation", () => {
  it("should test if bare :keyword works", async () => {
    try {
      const result = await execOne(":keyword");
      console.log("Bare :keyword result:", result, "Type:", typeof result);
      expect(true).toBe(true); // Just log, don't fail
    } catch (e: any) {
      console.log("Bare :keyword failed:", e.message);
      expect(e.message).toContain("Unbound variable");
    }
  });

  it("should test if bare :keyword works as getter", async () => {
    const result = await execOne("(:pasword obj)", sandboxedEnv.inherit({
      obj: {pasword: "swordfish"}
    }));
    expect(result.toString()).toBe("swordfish"); // Just log, don't fail
  });

  it("should test if quoted ':keyword works", async () => {
    try {
      const result = await execOne("':keyword");
      console.log("Quoted ':keyword result:", result, "Type:", result?.constructor?.name);
      expect(true).toBe(true);
    } catch (e: any) {
      console.log("Quoted ':keyword failed:", e.message);
    }
  });

  it("should test what Claude's actual query needs", async () => {
    const testObj = { name: "test-value", id: "test-id" };
    sandboxedEnv.set("project", testObj);

    // Try different syntaxes
    const tests = [
      { desc: "string", expr: '(@ project "name")' },
      { desc: "quoted symbol", expr: "(@ project 'name)" },
      { desc: "bare symbol", expr: "(@ project name)" }, // Will fail - unbound
      { desc: "escaped symbol", expr: "(@ project |name|)" }
    ];

    for (const { desc, expr } of tests) {
      try {
        const result = await execOne(expr);
        console.log(`✓ ${desc}: ${expr} => ${result}`);
      } catch (e: any) {
        console.log(`✗ ${desc}: ${expr} => ${e.message}`);
      }
    }
  });

  it("should test quotations", async () => {
    const result = await execOne(
      `(list |24|)`,
      sandboxedEnv.inherit({
        "24": "unqouted",
      })
    );

    expect(result.car.toString()).toEqual("unqouted");
  });

  it("should support keywords with map", async () => {
    const users = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Charlie" }
    ];
    sandboxedEnv.set("users", users);

    expect(lipsToJs(await execOne(`(map :name users)`))).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("should support keywords in filter predicates", async () => {
    const items = [
      { active: true, name: "Item 1" },
      { active: false, name: "Item 2" },
      { active: true, name: "Item 3" }
    ];
    sandboxedEnv.set("items", items);

    // Filter using keyword extractor
    const filtered = lipsToJs(await execOne(`(filter :active items)`));

    expect(filtered).toHaveLength(2);
    expect(filtered[0].name).toBe("Item 1");
    expect(filtered[1].name).toBe("Item 3");
  });

  it("should handle missing keys gracefully", async () => {
    const obj = { name: "test" };
    sandboxedEnv.set("obj", obj);

    const result = await execOne(`(:missing obj)`);
    expect(result.constructor.name).toBe("Nil");
  });
});
