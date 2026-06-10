import { describe, expect, it } from "vitest";
import { env, exec } from "../stdlib";

/**
 * The runtime `dict` constructor — the canonical open-key map form
 * `(dict :k v …)`, paired with the `(:key d)` accessor. Round-trips:
 * construct with `dict`, read back with the keyword accessor.
 */
describe("dict constructor", () => {
  it("(:key (dict :k v …)) reads back the constructed values", async () => {
    const [a] = await exec(`(:a (dict :a 1 :b 2))`, { env });
    expect(Number((a as { valueOf: () => unknown }).valueOf())).toBe(1);

    const [b] = await exec(`(:b (dict :a 1 :b 2))`, { env });
    expect(Number((b as { valueOf: () => unknown }).valueOf())).toBe(2);
  });

  it("(dict) with no pairs is an empty object", async () => {
    const [n] = await exec(`(:missing (dict))`, { env });
    // accessor on an absent key returns nil
    expect(n == null || (n as { valueOf?: () => unknown })?.valueOf?.() == null).toBe(true);
  });
});
