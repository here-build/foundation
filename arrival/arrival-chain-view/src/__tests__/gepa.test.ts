/**
 * The golden: the full GEPA example chain → JS, both views. The committed golden
 * FILES (`fixtures/gepa.read.js`, `fixtures/gepa.run.js`) ARE the spec — readable,
 * diffable JS rather than scattered substring checks. Regenerate intentional
 * changes with `UPDATE_GOLDENS=1 pnpm test`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectToJs } from "../project.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (name: string) => readFileSync(fixtureDir + name, "utf8");

// `.scm` spill resolution reads sibling sources (here, metric.scm). Pure injection.
const requireSource = (path: string): string | undefined => {
  try {
    return read(path);
  } catch {
    return undefined;
  }
};

const UPDATE = process.env.UPDATE_GOLDENS === "1";
/** Assert `actual` equals the committed golden, or (re)write it under UPDATE_GOLDENS=1. */
function golden(name: string, actual: string): void {
  if (UPDATE) {
    writeFileSync(fixtureDir + name, actual);
    return;
  }
  expect(actual).toBe(read(name));
}

describe("gepa.scm → JS (golden files)", () => {
  it("read-view matches fixtures/gepa.read.js", async () => {
    golden("gepa.read.js", await projectToJs(read("gepa.scm"), { requireSource }));
  });

  it("run-view matches fixtures/gepa.run.js", async () => {
    golden("gepa.run.js", await projectToJs(read("gepa.scm"), { target: "run", requireSource }));
  });

  it("is deterministic (same source → same output)", async () => {
    const a = await projectToJs(read("gepa.scm"), { requireSource });
    const b = await projectToJs(read("gepa.scm"), { requireSource });
    expect(a).toBe(b);
  });
});
