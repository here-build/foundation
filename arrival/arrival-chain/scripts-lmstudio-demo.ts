/**
 * Bootstraps the herebuild-react pipeline on the y-websocket relay
 * and drains it via LM Studio's OpenAI-compatible API. Mirrors the demo
 * worker (scripts-lmstudio-worker.ts) but loads herebuild-react.scm with a
 * small personas slice instead of the translation toy.
 *
 *   pnpm tsx scripts-lmstudio-demo.ts \
 *     [--doc demo] [--ws ws://localhost:1235] \
 *     [--base http://localhost:1234/v1] [--model gemma-4-e4b-it] \
 *     [--personas path/to/profiles.json] [--replays 3]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ArrivalChain, Project, runProjectWorker } from "@here.build/arrival-chain";
import { type ModelBackend, type ModelSpec, lazyBackend, renderSchema, specMessages } from "@here.build/arrival-inference";
import ws from "ws";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

const DOC_ID = arg("doc", "demo");
const WS_URL = arg("ws", "ws://localhost:1235");
const BASE_URL = arg("base", "http://localhost:1234/v1");
const MODEL = arg("model", "gemma-4-e4b-it");
const TIER = arg("tier", "high");
const PERSONAS = arg("personas", path.resolve(import.meta.dirname, "../../.data/profiles-3-demo.json"));
const VARIANTS = arg("variants", path.resolve(import.meta.dirname, "../../scripts/arrival-chain/configs/herebuild-opus-15-run.variants.json"));
const REPLAYS = Number(arg("replays", "2"));

const PROGRAMS_DIR = path.resolve(import.meta.dirname, "../../scripts/arrival-chain/programs");

function lmstudioBackend(baseURL: string): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL, apiKey: "lm-studio" });
    return {
      async complete(spec: ModelSpec): Promise<unknown> {
        const messages = specMessages(spec);
        const schema = renderSchema(spec.schema);
        if (schema) {
          // gemma + most local models don't honor json_schema response_format
          // reliably. Push the schema into the system message and ask for
          // json_object, then JSON.parse.
          const schemaHint = `Respond ONLY with a JSON object matching this JSON Schema (no prose, no markdown):\n${JSON.stringify(schema)}`;
          const sys = messages.find((m) => m.role === "system");
          if (sys) sys.content = `${sys.content}\n\n${schemaHint}`;
          else messages.unshift({ role: "system", content: schemaHint });
        }
        const res = await client.chat.completions.create({
          model: spec.model,
          messages,
        });
        const text = res.choices[0]?.message?.content ?? "";
        if (!schema) return text;
        try {
          return JSON.parse(text);
        } catch {
          // Pull the first {...} block out of any stray prose/markdown.
          const m = text.match(/\{[\s\S]*\}/);
          return m ? JSON.parse(m[0]) : text;
        }
      },
    };
  });
}

async function main() {
  const yjsUrl = new URL(
    "./node_modules/@here.build/plexus/node_modules/yjs/dist/yjs.mjs",
    import.meta.url,
  );
  const ywsUrl = new URL(
    "./node_modules/@here.build/plexus/node_modules/y-websocket/src/y-websocket.js",
    import.meta.url,
  );
  const Y = await import(yjsUrl.href);
  const { WebsocketProvider } = await import(ywsUrl.href);

  const doc = new Y.Doc({ guid: DOC_ID });
  (globalThis as { WebSocket?: unknown }).WebSocket ??= ws;
  const provider = new WebsocketProvider(WS_URL, DOC_ID, doc, { WebSocketPolyfill: ws as never });
  provider.on("status", (e: { status: string }) => console.log("[ws]", e.status));

  await new Promise<void>((r) => provider.once("synced", () => r()));
  console.log("[ws] synced");

  let project: Project;
  if (doc.share.size === 0) {
    console.log("[bootstrap] doc empty — loading herebuild-react pipeline");
    const ENTRY = "herebuild-multi.scm";
    const entries = await fs.readdir(PROGRAMS_DIR);
    const personasJson = await fs.readFile(PERSONAS, "utf-8");
    const variantsJson = await fs.readFile(VARIANTS, "utf-8");
    project = ArrivalChain.bootstrap(new Project(), DOC_ID, doc).root;
    project.setEnv("replays", REPLAYS);
    project.setEnv("min-replays", REPLAYS);
    project.setEnv("total-count", 6);
    project.setEnv("batch-size", 3);
    project.setEnv("bounce-threshold", 0.5);
    project.setEnv("max-iter", 3);
    project.setEnv("total-iter-cap", 6);
    project.setEnv("plateau-delta", 0.05);
    project.setEnv("min-for-boundary", 2);
    project.setEnv("pov-count", 3);
    project.setEnv("hero-id", "DEMO");
    project.setEnv("hero-lead", "A visual studio that compiles to the React/TS code you'd have written. Point it at your component library and tokens; it emits files in your repo.");
    project.setEnv("initial-tagline", "Build apps visually. Bring your own AI.");
    project.setEnv("product-context", "here.build — a visual studio that compiles to the React/TS code you'd have written, against your component library and tokens. No runtime, no JSON blob.");
    project.setEnv("system-prompt", "You are a synthetic respondent in a customer-research test. Stay strictly in character. React in the voice of the person described below — with their priors, their pains, their dealbreakers, their dismissive reactions. Do not soften. Be terse: 2–4 sentences per part, no preamble, no caveats about being an AI.");
    project.addFile("personas.json", personasJson);
    project.addFile("variants.json", variantsJson);
    // Load every program/template file so they're visible in the monitor.
    for (const name of entries) {
      if (!name.endsWith(".scm") && !name.endsWith(".hbs")) continue;
      const src = await fs.readFile(path.join(PROGRAMS_DIR, name), "utf-8");
      if (name.endsWith(".scm")) project.addProgram(name, src);
      else project.addFile(name, src);
    }
    // Ensure the desired entry is the one we'll execute.
    if (!entries.includes(ENTRY)) throw new Error(`entry not found: ${ENTRY}`);
    (project as unknown as { __entry: string }).__entry = ENTRY;
  } else {
    console.log("[bootstrap] doc has state — connecting");
    project = ArrivalChain.connect(doc).root;
  }

  Project.registerBackend("lmstudio", lmstudioBackend(BASE_URL));
  console.log(`[worker] tier=${TIER} → lmstudio:${MODEL} via ${BASE_URL}; personas=${PERSONAS} replays=${REPLAYS}`);

  const { autorun } = await import("mobx");
  autorun(() => {
    const tasks = [...project.tasks.values()];
    const done = tasks.filter((t) => t.result !== null).length;
    if (tasks.length > 0) console.log(`[tasks] ${done}/${tasks.length} done`);
  });

  const stop = new AbortController();
  process.on("SIGINT", () => { console.log("\n[worker] stopping"); stop.abort(); });

  // Kick off the entry program so tasks get enqueued.
  const entryPath = (project as unknown as { __entry?: string }).__entry ?? "herebuild-multi.scm";
  const entry = project.findFile(entryPath) ?? [...project.files.values()][0];
  if (entry) {
    entry.run().then(
      (v) => console.log("[program] done:", JSON.stringify(v).slice(0, 200)),
      (e) => console.error("[program] error:", e),
    );
  }

  await runProjectWorker(project, { signal: stop.signal });
  console.log("[worker] exited");
}

main().catch((e) => { console.error(e); process.exit(1); });
