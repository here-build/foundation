/**
 * Test all examples from the Quick Start section to ensure they work
 */

import { describe, expect, it } from "vitest";
import { exec, sandboxedEnv, lipsToJs, jsToLips } from "../index";

describe("Quick Start Examples", () => {
  it("Basic execution example", async () => {
    const results = await exec(
      `
  (filter (lambda (x) (> x 5))
    (list 1 3 7 9 2))
`,
      { env: sandboxedEnv }
    );

    expect(lipsToJs(results[0], {})).toEqual([7, 9]);
  });

  it("Register custom functions with Rosetta", async () => {
    // Register a domain function - JS arrays become Scheme lists automatically
    sandboxedEnv.defineRosetta("double-all", {
      fn: (numbers: number[]) => numbers.map((x) => x * 2)
    });

    const results = await exec(
      `
  (double-all (list 1 2 3 4 5))
`,
      { env: sandboxedEnv }
    );

    expect(lipsToJs(results[0], {})).toEqual([2, 4, 6, 8, 10]);
  });

  it("Working with complex data", async () => {
    // Register function that filters objects
    sandboxedEnv.defineRosetta("high-priority-users", {
      fn: (users: Array<{ id: string; priority: number }>) => users.filter((u) => u.priority > 10)
    });

    // Pass JS data to Scheme
    const users = [
      { id: "alice", priority: 15 },
      { id: "bob", priority: 5 },
      { id: "charlie", priority: 20 }
    ];

    sandboxedEnv.set("users", jsToLips(users, {}));

    const results = await exec(
      `
  (high-priority-users users)
`,
      { env: sandboxedEnv }
    );

    const result = lipsToJs(results[0], {});
    expect(result).toEqual([
      { id: "alice", priority: 15 },
      { id: "charlie", priority: 20 }
    ]);
  });
});
