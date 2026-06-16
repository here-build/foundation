/**
 * InferString — the rich inference response. Properties under test:
 *   - it IS a scheme string (extends AString) and coerces to the bare text — so
 *     `string?`/`string-length`/interpolation accept it, and `toJs()`/`valueOf()`
 *     return the plain string (the payload does NOT cross the JS membrane);
 *   - it carries `reasoning` + `chunks` host-side (read off the instance);
 *   - `withProvenance` PRESERVES the payload (the silent-loss gotcha the spike flagged);
 *   - in the interpreter the value is string-transparent, but the `__`-prefixed payload
 *     is GATED from the program by the sandbox `@` accessor (external-only).
 */
import { AString, execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { InferString } from "../infer-string.js";
import type { Chunk, ToolCall } from "../model.js";

const chunks: Chunk[] = [
  { kind: "text", text: "ok" },
  { kind: "tool_call", server: "linear", tool: "create_issue", arguments: { title: "Bug" } },
];

const toolCalls: ToolCall[] = [{ id: "c1", name: "create_issue", arguments: { title: "Bug" } }];

describe("InferString — string-transparent, external-only payload", () => {
  it("is a scheme string and coerces to the bare text (payload does not cross to JS)", () => {
    const s = new InferString("the answer", "i reasoned", chunks);
    expect(s).toBeInstanceOf(AString);
    expect(AString.isString(s)).toBe(true);
    expect(s.valueOf()).toBe("the answer");
    expect(`${s}`).toBe("the answer");
    expect(s.toJs()).toBe("the answer");
  });

  it("carries reasoning + chunks host-side", () => {
    const s = new InferString("a", "r", chunks);
    expect(s.__reasoning__).toBe("r");
    expect(s.__chunks__).toEqual(chunks);
  });

  it("carries toolCalls host-side (defaulting to empty) and preserves them across withProvenance", () => {
    expect(new InferString("a", "r", chunks).__toolCalls__).toEqual([]); // default when omitted
    const s = new InferString("", "", [], toolCalls);
    expect(s.__toolCalls__).toEqual(toolCalls);
    const s2 = s.withProvenance(new Set([9]));
    expect(s2.__toolCalls__).toEqual(toolCalls); // not dropped on re-stamp
  });

  it("withProvenance preserves the payload (the silent-loss gotcha)", () => {
    const s = new InferString("a", "r", chunks);
    const p: ReadonlySet<number> = new Set([1, 2]);
    const s2 = s.withProvenance(p);
    expect(s2).toBeInstanceOf(InferString);
    expect(s2.__reasoning__).toBe("r");
    expect(s2.__chunks__).toEqual(chunks);
    expect(s2.provenance).toBe(p);
    expect(s2.valueOf()).toBe("a");
  });

  it("in scheme: string-transparent, but the payload is gated from the program", async () => {
    const env = sandboxedEnv.inherit("infer-string-test");
    const s = new InferString("hello", "because", chunks);
    env.defineRosetta("result", { fn: () => s });
    const run = async (scm: string): Promise<unknown> => {
      const r = await exec(scm, { env });
      const last = r.at(-1);
      return last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
    };
    expect(await run(`(string? (result))`)).toBe(true);
    // `string-length` returns a boxed SchemeExact (the canonical numeric tower value)
    // — coerce via valueOf to assert the magnitude. (It used to return a raw JS number
    // from an inference-env inline shadow; that loose copy was dropped 2026-06-16 in
    // favor of the strings pack's provenance-carrying boxed result.)
    expect(Number(await run(`(string-length (result))`))).toBe(5);
    // the __-prefixed payload is gated by the sandbox @ accessor — the program can't read it.
    expect(await run(`(@ (result) "__chunks__")`)).not.toEqual(chunks);
  });
});
