/**
 * The 4-target prompt matrix: one `.prompt` → four idiomatic runnable modules.
 * The committed golden FILES (`improve.<backend>.{ts,py}`) ARE the spec — readable,
 * diffable, regenerated with `UPDATE_GOLDENS=1 pnpm test`. `improve.prompt` is the
 * rich case (frontmatter model + `{{role}}` + a `{{#each}}` loop); `predict.prompt`
 * the simple var-only case for the focused units.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPromptBackend, type PromptBackend } from "../prompt.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (name: string) => readFileSync(fixtureDir + name, "utf8");
const UPDATE = process.env.UPDATE_GOLDENS === "1";
function golden(name: string, actual: string): void {
  if (UPDATE) {
    writeFileSync(fixtureDir + name, actual);
    return;
  }
  expect(actual).toBe(read(name));
}

const improve = read("improve.prompt");
const predict = read("predict.prompt");

const GOLDENS: [PromptBackend["id"], string][] = [
  ["ax", "improve.ax.ts"],
  ["langchain-js", "improve.langchain.ts"],
  ["dspy", "improve.dspy.py"],
  ["langchain-py", "improve.langchain.py"],
];

describe("prompt matrix — improve.prompt (model + role + each-loop) golden", () => {
  for (const [id, file] of GOLDENS) {
    it(`${id} → ${file}`, () => {
      golden(file, getPromptBackend(id).compile(improve, "improve").code);
    });
  }
});

describe("prompt matrix — module filenames follow each language's convention", () => {
  it("JS backends emit <stem>.prompt.ts; Python backends emit <stem>_prompt.py", () => {
    expect(getPromptBackend("ax").compile(improve, "improve").filename).toBe("improve.prompt.ts");
    expect(getPromptBackend("langchain-js").compile(improve, "improve").filename).toBe("improve.prompt.ts");
    expect(getPromptBackend("dspy").compile(improve, "improve").filename).toBe("improve_prompt.py");
    expect(getPromptBackend("langchain-py").compile(improve, "improve").filename).toBe("improve_prompt.py");
  });
  it("export names: inferImprove (JS) / infer_improve (Python)", () => {
    expect(getPromptBackend("ax").compile(improve, "improve").exportName).toBe("inferImprove");
    expect(getPromptBackend("dspy").compile(improve, "improve").exportName).toBe("infer_improve");
  });
});

describe("prompt matrix — client modules", () => {
  it("each backend ships its endpoint module", () => {
    expect(getPromptBackend("ax").client().filename).toBe("_ai.ts");
    expect(getPromptBackend("langchain-js").client()).toMatchObject({ filename: "_llm.ts" });
    expect(getPromptBackend("dspy").client().code).toContain("dspy.LM");
    expect(getPromptBackend("langchain-py").client().code).toContain("ChatOpenAI");
  });
});

describe("prompt matrix — predict.prompt (var-only, no loop)", () => {
  it("dspy builds a typed two-input signature", () => {
    const code = getPromptBackend("dspy").compile(predict, "predict").code;
    expect(code).toContain("instruction: str = dspy.InputField()");
    expect(code).toContain("input: str = dspy.InputField()");
    expect(code).toContain("output: str = dspy.OutputField()");
    expect(code).toContain("def infer_predict(instruction, input):");
  });
  it("langchain backends skip the loop pre-render when there's no each", () => {
    expect(getPromptBackend("langchain-js").compile(predict, "predict").code).toContain("return chain.invoke(args);");
    expect(getPromptBackend("langchain-js").compile(predict, "predict").code).not.toContain(".map((it)");
    expect(getPromptBackend("langchain-py").compile(predict, "predict").code).not.toContain('"\\n".join(f"');
  });
});

describe("prompt matrix — each-loop becomes a call-time pre-render", () => {
  it("langchain-js maps the array into a joined block, passes it through invoke", () => {
    const code = getPromptBackend("langchain-js").compile(improve, "improve").code;
    expect(code).toContain("const failures = args.failures.map((it) => `  - ${it.input}  → expected: ${it.expected}`).join(\"\\n\");");
    expect(code).toContain("return chain.invoke({ ...args, failures });");
  });
  it("langchain-py joins an f-string comprehension over the list", () => {
    const code = getPromptBackend("langchain-py").compile(improve, "improve").code;
    expect(code).toContain(`failures = "\\n".join(f"  - {it['input']}  → expected: {it['expected']}" for it in failures)`);
  });
});
