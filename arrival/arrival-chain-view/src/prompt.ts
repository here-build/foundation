/**
 * The `.prompt → .prompt.ts` compiler — transpilation, same as scheme → JS. A
 * `.prompt` (YAML frontmatter `model:` + a Handlebars body whose `{{vars}}` are the
 * inputs) compiles to a TS module that default-exports an ax-backed async
 * `infer<Name>` function: the RUNNABLE twin of the read-view's
 * `import x from "./y.prompt"`.
 *
 * v1 fidelity note: the ax program is built from the signature (`inputs -> output`),
 * which ax compiles to its own prompt. The hand-written Handlebars template is
 * preserved verbatim in a comment for the human and as the hook for wiring it into
 * ax's prompt generation (a refinement — ax's leading-description syntax wasn't
 * verified here, so it's kept out of the signature to guarantee a valid program).
 */
import { cleanName } from "./names.js";

export interface CompiledPrompt {
  /** The generated `.prompt.ts` source. */
  code: string;
  /** The exported function name, e.g. `inferPredict`. */
  exportName: string;
  /** The input fields extracted from the template. */
  inputs: { name: string; type: "string" | "json" }[];
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { meta, body: src.slice(m[0].length) };
}

/** Handlebars block helpers / context refs that are NOT input variables. */
const HELPERS = new Set(["role", "each", "if", "unless", "with", "this", "else", "lookup", "log"]);

/** Input fields of a Handlebars body: top-level `{{var}}` (string) + `{{#each xs}}`
 *  collections (json). `{{this.x}}` inside an each refers to the item, not an input. */
function extractInputs(body: string): { name: string; type: "string" | "json" }[] {
  const arrays = new Set<string>();
  for (const m of body.matchAll(/\{\{#each\s+([\w.]+)/g)) arrays.add(m[1]!.split(".")[0]!);
  const fields = new Map<string, "string" | "json">();
  for (const m of body.matchAll(/\{\{\{?\s*([\w.]+)/g)) {
    const head = m[1]!.split(".")[0]!;
    if (HELPERS.has(head)) continue;
    if (!fields.has(head)) fields.set(head, "string");
  }
  for (const a of arrays) fields.set(a, "json"); // a collection is json, overriding string
  return [...fields].map(([name, type]) => ({ name: cleanName(name), type }));
}

const pascal = (s: string): string => cleanName(s).replace(/^[a-z]/, (c) => c.toUpperCase());

/** Compile a `.prompt` source to its `.prompt.ts` module. `promptName` is the file stem. */
export function compilePromptToTs(source: string, promptName: string): CompiledPrompt {
  const { meta, body } = parseFrontmatter(source);
  const inputs = extractInputs(body);
  const model = meta.model ?? "";
  const exportName = `infer${pascal(promptName)}`;

  const sig = `${inputs.map((f) => `${f.name}:${f.type}`).join(", ")} -> output:string`;
  const argType = `{ ${inputs.map((f) => `${f.name}: ${f.type === "json" ? "unknown" : "string"}`).join("; ")} }`;
  const template = body
    .trim()
    .split("\n")
    .map((l) => `//   ${l}`)
    .join("\n");

  const code = `// Generated from ${promptName}.prompt by @here.build/arrival-chain-view — do not edit.
import { ax } from "@ax-llm/ax";

import { llm } from "./_ai.js";

// Prompt template${model ? ` (model: ${model})` : ""}:
${template}
const program = ax(${JSON.stringify(sig)});

export default async function ${exportName}(args: ${argType}): Promise<string> {
  const { output } = await program.forward(llm, args${model ? `, { model: ${JSON.stringify(model)} }` : ""});
  return output;
}
`;
  return { code, exportName, inputs };
}

/** The shared ax client module a compiled project imports as `./_ai.js`. Configure
 *  the endpoint once; every `.prompt.ts` reuses it. OpenAI-compatible by default
 *  (LM Studio / Ollama / vLLM / OpenAI). */
export function aiClientModule(): string {
  return `// The shared ax LLM client. Point it at your endpoint.
import { ai } from "@ax-llm/ax";

export const llm = ai({
  name: "openai", // OpenAI-compatible: LM Studio / Ollama / vLLM / OpenAI
  apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
  options: { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1" },
});
`;
}
