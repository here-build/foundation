/**
 * End-to-end demo: best-tagline.scm against local LM Studio (Gemma).
 *
 *   1. Skips if LM Studio isn't reachable at http://localhost:1234.
 *   2. Loads the canonical .scm + 4 templates from disk.
 *   3. Backend = OpenAI-compatible against LM Studio. Schema mode goes
 *      via prompt (Gemma doesn't reliably honour response_format=json_schema),
 *      with tolerant JSON parsing on the way back (strips ```json fences,
 *      finds the first {…} block if the model added prose).
 *   4. Runs with the smoke config (3 personas, max-iter=0, no triage)
 *      so the demo finishes in seconds and costs nothing.
 *
 * Output is logged; the spec only asserts the result tree is well-formed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { lazyBackend, parseChatPrompt, renderSchema } from "../backends/_shared.js";
import type { ModelBackend, ModelSpec } from "../model.js";
import { Project } from "../project.js";
import { runProjectWorker } from "../worker.js";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1";
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL ?? "gemma-4-e4b-it";
const WS_URL = process.env.AC_WS_URL ?? "ws://localhost:1235";
const DOC_ID = process.env.AC_DOC_ID ?? "best-tagline-demo";

const PROGRAMS_DIR = path.resolve(__dirname, "../../../../../../50testers/scripts/arrival-chain/programs");
const read = (name: string) => readFileSync(path.join(PROGRAMS_DIR, name), "utf-8");

const PERSONAS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../../../50testers/.data/personas-3-smoke.json"), "utf-8"),
);

/** Tolerant JSON extractor — strips fences, finds first balanced {…}. */
function parseLooseJson(text: string): unknown {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error(`no JSON object in: ${text.slice(0, 200)}`);
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }
  throw new Error(`unbalanced JSON in: ${text.slice(0, 200)}`);
}

function lmstudioBackend(baseURL: string): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL, apiKey: "lm-studio" });
    return {
      async complete(spec: ModelSpec): Promise<unknown> {
        const messages = parseChatPrompt(spec.prompt) ?? [{ role: "user" as const, content: spec.prompt }];
        const schema = renderSchema(spec.schema);
        // Gemma doesn't reliably honour response_format=json_schema, so we
        // bolt the schema onto the user message and parse loosely on return.
        const augmented = schema
          ? [
              ...messages.slice(0, -1),
              {
                ...messages[messages.length - 1]!,
                content:
                  (messages[messages.length - 1]?.content ?? "") +
                  `\n\nOutput ONLY valid JSON matching this schema (no fences, no prose):\n${JSON.stringify(schema)}`,
              },
            ]
          : messages;
        const res = await client.chat.completions.create({
          model: spec.model,
          messages: augmented,
          temperature: 0.7,
        });
        const text = res.choices[0]?.message?.content ?? "";
        return spec.schema !== null ? parseLooseJson(text) : text;
      },
    };
  });
}

async function lmStudioUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/models`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

/** Probe the ws relay by opening a TCP connection — non-blocking, ~200ms. */
async function wsUp(): Promise<boolean> {
  const url = new URL(WS_URL);
  return new Promise<boolean>((resolve) => {
    const net = require("node:net") as typeof import("node:net");
    const s = net.createConnection({ host: url.hostname, port: Number(url.port || 80) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once("connect", () => done(true));
    s.once("error",   () => done(false));
    setTimeout(() => done(false), 300);
  });
}

describe("best-tagline.scm × LM Studio (Gemma) — live demo", () => {
  it("runs the smoke config against local Gemma", async ({ skip }) => {
    if (!(await lmStudioUp())) skip(`LM Studio not reachable at ${LM_STUDIO_URL}`);

    // Publish to the ws relay if it's up so the monitor (apps/monitor-chain)
    // can observe the run live. Open http://localhost:5273/?doc=best-tagline-demo
    // in a browser to watch.
    let provider: { destroy: () => void } | null = null;
    let doc: { share: { size: number } } | null = null;
    if (await wsUp()) {
      const Y = await import("yjs");
      const { WebsocketProvider } = await import("y-websocket");
      const ws = await import("ws");
      doc = new Y.Doc({ guid: DOC_ID }) as never;
      (globalThis as { WebSocket?: unknown }).WebSocket ??= ws.default;
      provider = new WebsocketProvider(WS_URL, DOC_ID, doc as never, { WebSocketPolyfill: ws.default as never }) as {
        destroy: () => void;
      };
      await new Promise<void>((r) => (provider as never as { once: (e: string, f: () => void) => void }).once("synced", () => r()));
      console.log(`[ws] synced to ${WS_URL} doc=${DOC_ID}`);
      console.log(`[ui] open http://localhost:5273/?doc=${DOC_ID} to watch live`);
    } else {
      console.log(`[ws] ${WS_URL} not reachable — running local-only (no monitor)`);
    }

    const project = doc && doc.share.size > 0
      ? ArrivalChain.connect(doc as never).root
      : ArrivalChain.bootstrap(new Project(), DOC_ID, doc as never).root;

    project.addFile("personas.json", JSON.stringify(PERSONAS));
    project.addFile("main.scm",                  read("best-tagline.scm"));
    project.addFile("summary-of-persona.hbs",    read("summary-of-persona.hbs"));
    project.addFile("tagline-reaction.hbs",      read("tagline-reaction.hbs"));
    project.addFile("reflection-prompt.hbs",     read("reflection-prompt.hbs"));
    project.addFile("triage-prompt.hbs",         read("triage-prompt.hbs"));
    project.addFile("consolidation-prompt.hbs",  read("consolidation-prompt.hbs"));
    project.addFile("merge-prompt.hbs",          read("merge-prompt.hbs"));

    // System prompts live in the .scm. Env carries only the per-run knobs.
    project.setEnv("initial-tagline", "A visual studio that compiles to the code you'd have written.");
    project.setEnv("pov-count",       1); // bump to 4 to see multi-POV diversity (4× LLM calls)
    project.setEnv("max-iter",          2);
    project.setEnv("plateau-delta",     0.02);
    project.setEnv("total-iter-cap",    2);
    project.setEnv("bounce-threshold",  2.0); // never trigger triage in smoke

    project.setModel("fast", "lmstudio", LM_STUDIO_MODEL);
    project.setModel("high", "lmstudio", LM_STUDIO_MODEL);
    Project.registerBackend("lmstudio", lmstudioBackend(LM_STUDIO_URL));

    const ac = new AbortController();
    const draining = runProjectWorker(project, { signal: ac.signal });

    const program = project.addProgram("main.scm", read("best-tagline.scm"));
    const result = (await program.run()) as {
      tree: Array<Record<string, unknown>>;
      compound: { format: string; tagline: string; score: number; pov: string; sources: string[] } | false;
      buckets: Array<Record<string, unknown>>;
      summaries: Record<string, { summary: string; "key-points": string[] }>;
    };

    console.log("\n=== best-tagline tree ===");
    for (const node of result.tree) {
      console.log(`  node #${node.id}  parent=${node["parent-id"]}  tagline="${node.tagline}"  bounce=${node["bounce-rate"]}`);
      for (const r of (node.reactions as Array<Record<string, unknown>>)) {
        console.log(`    ${(r.verdict as string).padEnd(13)} ${(r.concern as string).slice(0, 80)}`);
      }
    }

    if (result.compound && typeof result.compound === "object") {
      console.log(`\n=== compound (${result.compound.format}, POV: ${result.compound.pov}, score=${result.compound.score}) ===`);
      console.log(`  "${result.compound.tagline}"`);
      console.log(`  sources: ${result.compound.sources.map(s => `"${s.slice(0, 50)}…"`).join(" + ")}`);
    }

    console.log("\n=== per-persona buckets ===");
    for (const b of result.buckets) {
      const tagline = typeof b.tagline === "string" ? ` → "${b.tagline.slice(0, 70)}"` : "";
      const reason  = typeof b.reason  === "string" && b.reason ? `  (${b.reason.slice(0, 80)})` : "";
      console.log(`  ${(b.id as string).padEnd(28)} ${(b.bucket as string).padEnd(15)}${tagline}${reason}`);
    }

    console.log("\n=== summaries ===");
    for (const [label, s] of Object.entries(result.summaries)) {
      if (s.summary) {
        console.log(`  [${label}] ${s.summary}`);
        for (const p of s["key-points"] ?? []) console.log(`    • ${p}`);
      }
    }

    expect(result.tree.length).toBeGreaterThan(0);
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.summaries["audience-miss"]).toBeDefined();
    expect(result.summaries.unreachable).toBeDefined();

    ac.abort(); await draining;
    // y-websocket 2.1.0 + y-protocols 1.0.7 occasionally throw inside
    // awareness teardown when the doc had no awareness traffic; harmless
    // for the test outcome — the doc + program updates already flushed.
    try { provider?.destroy(); } catch { /* swallow */ }
  }, 300_000); // 5-minute timeout — multi-iter loop + monitor observation
});
