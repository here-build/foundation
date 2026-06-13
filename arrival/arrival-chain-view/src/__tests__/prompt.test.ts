/**
 * The `.prompt → .prompt.ts` compiler: a Handlebars prompt → an ax-backed
 * `infer<Name>` module.
 */
import { describe, expect, it } from "vitest";

import { aiClientModule, compilePromptToTs } from "../prompt.js";

const PREDICT = `---
model: qwen3.5-9b
---
{{role "user"}}
{{instruction}}

{{input}}
`;

const IMPROVE = `---
model: qwen3.5-9b
---
{{role "user"}}
The instruction below is underperforming. Rewrite it to fix the failures.

Current instruction:
{{instruction}}

It was wrong on these cases:
{{#each failures}}
  - {{this.input}}  → expected: {{this.expected}}
{{/each}}

Reply with only the improved instruction.
`;

describe("compilePromptToTs", () => {
  it("predict.prompt → inferPredict with instruction + input string inputs", () => {
    const { code, exportName, inputs } = compilePromptToTs(PREDICT, "predict");
    expect(exportName).toBe("inferPredict");
    expect(inputs).toEqual([
      { name: "instruction", type: "string" },
      { name: "input", type: "string" },
    ]);
    expect(code).toContain('import { ax } from "@ax-llm/ax";');
    expect(code).toContain('import { llm } from "./_ai.js";');
    expect(code).toContain('const program = ax("instruction:string, input:string -> output:string");');
    expect(code).toContain("export default async function inferPredict(args: { instruction: string; input: string })");
    expect(code).toContain('await program.forward(llm, args, { model: "qwen3.5-9b" })');
    expect(code).toContain("return output;");
  });

  it("improve.prompt → a #each collection becomes a json input", () => {
    const { code, inputs } = compilePromptToTs(IMPROVE, "improve");
    expect(inputs).toEqual([
      { name: "instruction", type: "string" },
      { name: "failures", type: "json" },
    ]);
    expect(code).toContain("instruction:string, failures:json -> output:string");
    expect(code).toContain("failures: unknown");
  });

  it("preserves the Handlebars template verbatim (as a comment)", () => {
    const { code } = compilePromptToTs(PREDICT, "predict");
    expect(code).toContain("// Prompt template (model: qwen3.5-9b):");
    expect(code).toContain("//   {{instruction}}");
  });

  it("a kebab prompt name → camel infer fn + camel inputs", () => {
    const { exportName } = compilePromptToTs("{{max-words}}", "run-predict");
    expect(exportName).toBe("inferRunPredict");
  });

  it("the shared ai client module is OpenAI-compatible + env-driven", () => {
    const m = aiClientModule();
    expect(m).toContain('import { ai } from "@ax-llm/ax";');
    expect(m).toContain("export const llm = ai({");
    expect(m).toContain("baseURL: process.env.OPENAI_BASE_URL");
  });
});
