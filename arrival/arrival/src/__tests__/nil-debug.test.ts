/**
 * Debug nil availability in LIPS
 */

import { describe, it } from "vitest";
import { env as lipsGlobalEnv, exec } from "@here.build/arrival-scheme";

describe("Nil Debug", () => {
  it("should find nil in LIPS environment", async () => {
    console.log("=== SEARCHING FOR NIL ===");

    // Try different nil variations
    const nilVariations = ["nil", "null", "NULL", "#nil", "()"];

    for (const variation of nilVariations) {
      const value = lipsGlobalEnv.get(variation, { throwError: false });
      console.log(`${variation}:`, value, typeof value);
    }

    // Try executing empty list
    try {
      const emptyList = await exec("()");
      console.log("Empty list exec result:", emptyList);
      console.log("Empty list type:", emptyList[0]?.constructor?.name);
    } catch (error) {
      console.log("Empty list error:", error.message);
    }

    // Try executing nil directly
    try {
      const nilResult = await exec("nil");
      console.log("nil exec result:", nilResult);
    } catch (error) {
      console.log("nil exec error:", error.message);
    }

    // Check what cons(1, null) returns
    const cons = lipsGlobalEnv.get("cons", { throwError: false });
    if (cons) {
      try {
        const pair1 = cons(1, null);
        console.log("cons(1, null):", pair1);

        const pair2 = cons(1, undefined);
        console.log("cons(1, undefined):", pair2);

        // Try creating a list and see what the end looks like
        const list = cons(1, cons(2, cons(3, null)));
        console.log("List with null:", list);

        // Walk to the end
        let current = list;
        while (current && current.cdr) {
          current = current.cdr;
        }
        console.log("Last cdr:", current?.cdr, typeof current?.cdr);
      } catch (error) {
        console.log("cons error:", error.message);
      }
    }

    // Check for list function
    const listFn = lipsGlobalEnv.get("list", { throwError: false });
    if (listFn) {
      try {
        const emptyListResult = listFn();
        console.log("list() result:", emptyListResult);
        console.log("list() type:", emptyListResult?.constructor?.name);
      } catch (error) {
        console.log("list() error:", error.message);
      }
    }
  });
});
