// Generated from improve.prompt by @here.build/arrival-chain-view — do not edit.
import { ax } from "@ax-llm/ax";

import { llm } from "./_ai.js";

// Prompt template (model: qwen3.5-9b):
//   {{role "user"}}
//   The instruction below is underperforming. Rewrite it to fix the failures.
//   
//   Current instruction:
//   {{instruction}}
//   
//   It was wrong on these cases:
//   {{#each failures}}
//     - {{this.input}}  → expected: {{this.expected}}
//   {{/each}}
//   
//   Reply with only the improved instruction.
const program = ax("instruction:string, failures:json -> output:string");

export default async function inferImprove(args: { instruction: string; failures: unknown }): Promise<string> {
  const { output } = await program.forward(llm, args, { model: "qwen3.5-9b" });
  return output;
}
