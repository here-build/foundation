/**
 * D2 — the racy-MCP-call lint. The server-tape index is positional (per inference, per
 * server, nth-call); inside a parallel HOF arm the arms fire out of order, so the index is
 * racy and a non-idempotent call can mis-sequence on replay. The lint flags taped dispatches
 * (`mcp/call` / `mcp/list` / `infer/agentic/end-to-end`) in parallel arms; allowed at a
 * sequence point (top level, a fold/loop arm). Same class as the reflective-read lint.
 */
import { parseGenerator } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { lintRacyMcpCalls } from "../racy-read-lint.js";

const lint = async (src: string) => lintRacyMcpCalls(await parseGenerator(src));

describe("lintRacyMcpCalls — taped MCP dispatches in parallel arms", () => {
  it("flags (mcp/call …) inside a (map …) arm + routes to sequencing", async () => {
    const findings = await lint(`(map (lambda (x) (mcp/call "srv" "write" x)) (list 1 2 3))`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.call).toBe("mcp/call");
    expect(findings[0]!.enclosingHof).toBe("map");
    expect(findings[0]!.message).toMatch(/racy/i);
    expect(findings[0]!.message).toMatch(/reduce|fold|loop/i); // routes to the fix
    expect(findings[0]!.message).toMatch(/idempotent/i); // names the harmless case
  });

  it("flags inside (filter …) and (for-each …) too", async () => {
    expect(await lint(`(filter (lambda (x) (mcp/call "s" "t" x)) xs)`)).toHaveLength(1);
    expect(await lint(`(for-each (lambda (x) (mcp/call "s" "t" x)) xs)`)).toHaveLength(1);
  });

  it("flags an agentic run fanned out in parallel (its server tapes race)", async () => {
    const findings = await lint(`(map (lambda (m) (infer/agentic/end-to-end "x" m srvs)) msgs)`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.call).toBe("infer/agentic/end-to-end");
  });

  it("does NOT flag a taped call at the top level or in a begin", async () => {
    expect(await lint(`(mcp/call "s" "t" args)`)).toHaveLength(0);
    expect(await lint(`(begin (mcp/call "s" "a" x) (mcp/call "s" "b" y))`)).toHaveLength(0);
  });

  it("does NOT flag a call inside a (reduce …) arm — folds are sequence points", async () => {
    const findings = await lint(`
      (reduce (lambda (acc x) (cons (mcp/call "s" "t" x) acc)) (list) xs)
    `);
    expect(findings).toHaveLength(0);
  });

  it("flags every taped call in one arm (not just the first)", async () => {
    const findings = await lint(`(map (lambda (x) (begin (mcp/call "s" "a" x) (mcp/list "s"))) xs)`);
    expect(findings.map((f) => f.call).sort()).toEqual(["mcp/call", "mcp/list"]);
  });
});
