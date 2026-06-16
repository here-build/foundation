// budget-capability.test.ts — assemble arrivalBudgetCapability onto a sandboxed base and assert
// the budget verbs bind, both armed and inert.

import { sandboxedEnv } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { assembleEnv } from "@here.build/arrival/env";
import { arrivalBudgetCapability } from "../packs/budget.js";

describe("arrivalBudgetCapability", () => {
  it("binds the budget verbs when inert (no spend)", async () => {
    const { env } = await assembleEnv(sandboxedEnv.inherit("t") as never, [arrivalBudgetCapability.lower({ config: {} })]);
    for (const verb of ["infer/spent", "infer/calls"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });

  it("binds the budget verbs when armed with a spend", async () => {
    const spend = { spent: () => 3, calls: () => 1, record: () => {} } as never;
    const { env } = await assembleEnv(sandboxedEnv.inherit("t") as never, [arrivalBudgetCapability.lower({ config: { spend } })]);
    for (const verb of ["infer/spent", "infer/calls"]) {
      expect(env.get(verb, { throwError: false })).toBeDefined();
    }
  });
});
