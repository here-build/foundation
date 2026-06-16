/**
 * The prompt backends — the `.prompt → runnable module` half of the matrix. The
 * PROGRAM lowering (scheme → JS/Python) is fixed per language; only the prompt
 * library swaps, hidden behind a uniform `infer<Name>(args)` the program calls.
 * Four backends across {JS, Python} × {signature-DSL, LangChain}:
 *
 *   ax           (JS,  signature)  — ax program from `inputs -> output`.
 *   langchain-js (JS,  template)   — ChatPromptTemplate reproducing the authored prompt.
 *   dspy         (Py,  signature)  — a dspy.Signature class + dspy.Predict.
 *   langchain-py (Py,  template)   — ChatPromptTemplate, the Python twin.
 *
 * Signature backends (ax, dspy) build a typed signature and keep the template as a
 * comment — the framework generates its own prompt. Template backends (the two
 * LangChains) reproduce the authored prompt verbatim, pre-rendering `{{#each}}`
 * loops to a joined string at call time (f-string templates don't iterate).
 */
import { type LoopSeg, parsePrompt, pascal, type PromptInput, renderMessages } from "./prompt-ir.js";
import { pyName } from "./python.js";

export interface PromptModule {
  /** Target filename, e.g. `predict.prompt.ts` / `predict_prompt.py`. */
  filename: string;
  /** The generated module source. */
  code: string;
  /** The exported entry, e.g. `inferPredict` / `infer_predict`. */
  exportName: string;
  /** Inputs extracted from the template. */
  inputs: PromptInput[];
}

export interface PromptBackend {
  id: "ax" | "langchain-js" | "dspy" | "langchain-py";
  lang: "js" | "py";
  /** Compile one `.prompt` into its target module. `promptName` is the file stem. */
  compile(source: string, promptName: string): PromptModule;
  /** The shared client module every compiled prompt imports (`_ai.ts` / `_llm.*`). */
  client(): { filename: string; code: string };
}

// ── shared snippet helpers ───────────────────────────────────────────────────

/** A line, escaped for use INSIDE a JS template literal. */
const jsTpl = (s: string): string => s.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

/** Render an each-loop body to a JS template-literal fragment (`it.field` interps). */
function jsLoopItem(item: LoopSeg[]): string {
  let s = "";
  for (const seg of item) s += seg.kind === "text" ? jsTpl(seg.text) : seg.path ? `\${it.${seg.path}}` : "${it}";
  return s.replaceAll(/^\n+|\n+$/g, "");
}

/** Render an each-loop body to a Python f-string fragment (`it['field']` interps). */
function pyLoopItem(item: LoopSeg[]): string {
  let s = "";
  for (const seg of item) {
    if (seg.kind === "text")
      s += seg.text
        .replaceAll("\\", "\\\\")
        .replaceAll('"', String.raw`\"`)
        .replaceAll("{", "{{")
        .replaceAll("}", "}}");
    else
      s += seg.path
        ? `{it[${seg.path
            .split(".")
            .map((p) => `'${p}'`)
            .join("][")}]}`
        : "{it}";
  }
  return s.replaceAll(/^\n+|\n+$/g, "");
}

/** A multi-line template → a readable joined string literal (single line stays inline). */
function jsTemplateLiteral(template: string): string {
  const lines = template.split("\n");
  if (lines.length <= 1) return JSON.stringify(template);
  return `[\n${lines.map((l) => `    ${JSON.stringify(l)}`).join(",\n")}\n  ].join("\\n")`;
}
function pyTemplateLiteral(template: string): string {
  const lines = template.split("\n");
  if (lines.length <= 1) return JSON.stringify(template);
  return `"\\n".join([\n${lines.map((l) => `        ${JSON.stringify(l)}`).join(",\n")}\n    ])`;
}

/** Frontmatter model → factory call argument: `"model"` or empty (factory env-defaults). */
const modelArg = (model: string): string => (model ? JSON.stringify(model) : "");
/** The authored template, preserved as a `//`/`#` comment block. */
const commentBody = (body: string, mark: string): string =>
  body
    .split("\n")
    .map((l) => `${mark}   ${l}`)
    .join("\n");

// ── ax (JS, signature) ───────────────────────────────────────────────────────

function compileAx(source: string, name: string): PromptModule {
  const doc = parsePrompt(source);
  const exportName = `infer${pascal(name)}`;
  const sig = `${doc.inputs.map((f) => `${f.name}:${f.type}`).join(", ")} -> output:string`;
  const argType = `{ ${doc.inputs.map((f) => `${f.name}: ${f.type === "json" ? "unknown" : "string"}`).join("; ")} }`;
  const code = `// Generated from ${name}.prompt by @here.build/arrival-chain-view — do not edit.
import { ax } from "@ax-llm/ax";

import { llm } from "./_ai.js";

// Prompt template${doc.model ? ` (model: ${doc.model})` : ""}:
${commentBody(doc.body, "//")}
const program = ax(${JSON.stringify(sig)});

export default async function ${exportName}(args: ${argType}): Promise<string> {
  const { output } = await program.forward(llm, args${doc.model ? `, { model: ${JSON.stringify(doc.model)} }` : ""});
  return output;
}
`;
  return { filename: `${name}.prompt.ts`, code, exportName, inputs: doc.inputs };
}

function axClient(): string {
  return `// The shared ax LLM client. Point it at your endpoint.
import { ai } from "@ax-llm/ax";

export const llm = ai({
  name: "openai", // OpenAI-compatible: LM Studio / Ollama / vLLM / OpenAI
  apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
  options: { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1" },
});
`;
}

// ── langchain-js (JS, template) ──────────────────────────────────────────────

function compileLangchainJs(source: string, name: string): PromptModule {
  const doc = parsePrompt(source);
  const exportName = `infer${pascal(name)}`;
  const rendered = renderMessages(doc.messages);
  const loops = rendered.flatMap((m) => m.loops);
  const loopVars = new Set(loops.map((l) => l.var));
  const msgs = rendered.map((m) => `  [${JSON.stringify(m.role)}, ${jsTemplateLiteral(m.template)}]`).join(",\n");
  const argType = `{ ${doc.inputs
    .map(
      (f) =>
        `${f.name}: ${loopVars.has(f.name) ? "Array<Record<string, unknown>>" : f.type === "json" ? "unknown" : "string"}`,
    )
    .join("; ")} }`;
  const pre = loops
    .map((l) => `  const ${l.var} = args.${l.var}.map((it) => \`${jsLoopItem(l.item)}\`).join("\\n");`)
    .join("\n");
  const invoke = loopVars.size > 0 ? `{ ...args, ${[...loopVars].join(", ")} }` : "args";
  const code = `// Generated from ${name}.prompt by @here.build/arrival-chain-view — do not edit.
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

import { chatModel } from "./_llm.js";

const prompt = ChatPromptTemplate.fromMessages([
${msgs},
]);
const chain = prompt.pipe(chatModel(${modelArg(doc.model)})).pipe(new StringOutputParser());

export default async function ${exportName}(args: ${argType}): Promise<string> {
${pre ? `${pre}\n` : ""}  return chain.invoke(${invoke});
}
`;
  return { filename: `${name}.prompt.ts`, code, exportName, inputs: doc.inputs };
}

function langchainJsClient(): string {
  return `// The shared LangChain chat model factory. Point it at your endpoint.
import { ChatOpenAI } from "@langchain/openai";

export function chatModel(model?: string) {
  return new ChatOpenAI({
    model: model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
    configuration: { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1" },
  });
}
`;
}

// ── dspy (Python, signature) ─────────────────────────────────────────────────

function compileDspy(source: string, name: string): PromptModule {
  const doc = parsePrompt(source);
  const stem = pyName(name);
  const exportName = `infer_${stem}`;
  const cls = pascal(name);
  const params = doc.inputs.map((f) => pyName(f.raw));
  const fields = doc.inputs
    .map((f) => `    ${pyName(f.raw)}: ${f.type === "json" ? "list" : "str"} = dspy.InputField()`)
    .join("\n");
  const docstring = (doc.description || `${name} prompt`).replaceAll('"""', "'''");
  const code = `# Generated from ${name}.prompt by @here.build/arrival-chain-view — do not edit.
import dspy

from _llm import lm

# Prompt template${doc.model ? ` (model: ${doc.model})` : ""}:
${commentBody(doc.body, "#")}
${stem}_lm = lm(${modelArg(doc.model)})


class ${cls}(dspy.Signature):
    """${docstring}"""

${fields}
    output: str = dspy.OutputField()


_${stem} = dspy.Predict(${cls})


def ${exportName}(${params.join(", ")}):
    with dspy.context(lm=${stem}_lm):
        return _${stem}(${params.map((p) => `${p}=${p}`).join(", ")}).output
`;
  return { filename: `${stem}_prompt.py`, code, exportName, inputs: doc.inputs };
}

function dspyClient(): string {
  return `# The shared dspy LM factory. Point it at your endpoint.
import os

import dspy


def lm(model: str = ""):
    name = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    return dspy.LM(
        f"openai/{name}",
        api_base=os.environ.get("OPENAI_BASE_URL", "http://localhost:1234/v1"),
        api_key=os.environ.get("OPENAI_API_KEY", "not-needed"),
    )
`;
}

// ── langchain-py (Python, template) ──────────────────────────────────────────

function compileLangchainPy(source: string, name: string): PromptModule {
  const doc = parsePrompt(source);
  const stem = pyName(name);
  const exportName = `infer_${stem}`;
  const rendered = renderMessages(doc.messages);
  const loops = rendered.flatMap((m) => m.loops);
  const msgs = rendered.map((m) => `    (${JSON.stringify(m.role)}, ${pyTemplateLiteral(m.template)})`).join(",\n");
  const params = doc.inputs.map((f) => pyName(f.raw));
  // The f-string placeholder is the cleaned name (renderMessages), the value is the snake param.
  const pre = loops
    .map((l) => String.raw`    ${pyName(l.raw)} = "\n".join(f"${pyLoopItem(l.item)}" for it in ${pyName(l.raw)})`)
    .join("\n");
  const invoke = doc.inputs.map((f) => `"${f.name}": ${pyName(f.raw)}`).join(", ");
  const code = `# Generated from ${name}.prompt by @here.build/arrival-chain-view — do not edit.
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from _llm import chat_model

prompt = ChatPromptTemplate.from_messages([
${msgs},
])
chain = prompt | chat_model(${modelArg(doc.model)}) | StrOutputParser()


def ${exportName}(${params.join(", ")}):
${pre ? `${pre}\n` : ""}    return chain.invoke({${invoke}})
`;
  return { filename: `${stem}_prompt.py`, code, exportName, inputs: doc.inputs };
}

function langchainPyClient(): string {
  return `# The shared LangChain chat model factory. Point it at your endpoint.
import os

from langchain_openai import ChatOpenAI


def chat_model(model: str = ""):
    return ChatOpenAI(
        model=model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        api_key=os.environ.get("OPENAI_API_KEY", "not-needed"),
        base_url=os.environ.get("OPENAI_BASE_URL", "http://localhost:1234/v1"),
    )
`;
}

// ── registry ─────────────────────────────────────────────────────────────────

export const PROMPT_BACKENDS: Record<PromptBackend["id"], PromptBackend> = {
  ax: { id: "ax", lang: "js", compile: compileAx, client: () => ({ filename: "_ai.ts", code: axClient() }) },
  "langchain-js": {
    id: "langchain-js",
    lang: "js",
    compile: compileLangchainJs,
    client: () => ({ filename: "_llm.ts", code: langchainJsClient() }),
  },
  dspy: { id: "dspy", lang: "py", compile: compileDspy, client: () => ({ filename: "_llm.py", code: dspyClient() }) },
  "langchain-py": {
    id: "langchain-py",
    lang: "py",
    compile: compileLangchainPy,
    client: () => ({ filename: "_llm.py", code: langchainPyClient() }),
  },
};

export function getPromptBackend(id: PromptBackend["id"]): PromptBackend {
  return PROMPT_BACKENDS[id];
}

// ── back-compat: the ax backend as the original named API ────────────────────

export interface CompiledPrompt {
  code: string;
  exportName: string;
  inputs: { name: string; type: "string" | "json" }[];
}

/** Compile a `.prompt` to its ax `.prompt.ts` module (the original JS+ax target). */
export function compilePromptToTs(source: string, promptName: string): CompiledPrompt {
  const m = compileAx(source, promptName);
  return { code: m.code, exportName: m.exportName, inputs: m.inputs.map((i) => ({ name: i.name, type: i.type })) };
}

/** The shared ax client module (`_ai.ts`). */
export function aiClientModule(): string {
  return axClient();
}
