// Generated from improve.prompt by @here.build/arrival-chain-view — do not edit.
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

import { chatModel } from "./_llm.js";

const prompt = ChatPromptTemplate.fromMessages([
  ["user", [
    "The instruction below is underperforming. Rewrite it to fix the failures.",
    "",
    "Current instruction:",
    "{instruction}",
    "",
    "It was wrong on these cases:",
    "{failures}",
    "",
    "Reply with only the improved instruction."
  ].join("\n")],
]);
const chain = prompt.pipe(chatModel("qwen3.5-9b")).pipe(new StringOutputParser());

export default async function inferImprove(args: { instruction: string; failures: Array<Record<string, unknown>> }): Promise<string> {
  const failures = args.failures.map((it) => `  - ${it.input}  → expected: ${it.expected}`).join("\n");
  return chain.invoke({ ...args, failures });
}
