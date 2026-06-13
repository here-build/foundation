/**
 * Bootstraps a shared arrival-chain Project on the y-websocket relay and runs
 * a worker that drains pending inference tasks via LM Studio's
 * OpenAI-compatible API. Monitor clients (browser) attach to the same doc and
 * observe in real time.
 *
 *   pnpm tsx scripts-lmstudio-worker.ts \
 *     [--doc trace-demo] [--ws ws://localhost:1235] \
 *     [--base http://localhost:1234/v1] [--model gemma-4-e4b-it]
 */
import { ArrivalChain, Project, runProjectWorker } from "@here.build/arrival-chain";
import { type ModelBackend, type ModelSpec } from "@here.build/arrival-inference";
import { lazyBackend, specMessages } from "@here.build/arrival-inference";
import ws from "ws";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

const DOC_ID = arg("doc", "trace-demo");
const WS_URL = arg("ws", "ws://localhost:1235");
const BASE_URL = arg("base", "http://localhost:1234/v1");
const MODEL = arg("model", "gemma-4-e4b-it");
const TIER = arg("tier", "fast");

function lmstudioBackend(baseURL: string): ModelBackend {
  return lazyBackend(async () => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL, apiKey: "lm-studio" });
    return {
      async complete(spec: ModelSpec): Promise<unknown> {
        const messages = specMessages(spec);
        const res = await client.chat.completions.create({
          model: spec.model,
          messages,
          // Gemma + most LM Studio models don't reliably support
          // response_format=json_schema. Skip it; (infer ...) calls without a
          // schema return plain text, which is what the demo program uses.
        });
        return res.choices[0]?.message?.content ?? "";
      },
    };
  });
}

// Demo program: round-trip an English phrase through French and back.
//
// Naming convention is "<result>-of-<input>": each definition expresses
// WHAT THE EXPRESSION IS, not what gets done. (fr-of-en x) IS the French
// of x — a noun, an identity relation. Reading the program is staring at
// expressions until the answer emerges; there's no interpreter to mentally
// simulate. Templates live in .hbs files named to mirror the binding.
const DEMO_FR_OF_EN_HBS = `French of: {{english}}
(Only the French translation. No quotes. No commentary.)`;

const DEMO_EN_OF_FR_HBS = `English of: {{french}}
(Only the English translation. No quotes. No commentary.)`;

const DEMO_SCM = `;; Each binding NAMES what the expression IS.
;; `+ "`" + `fr-of-en` + "`" + ` is "the French of an English phrase" — not "translate".
(define fr-of-en
  (lambda (english) (car (infer "fast" ((require "fr-of-en.hbs") english)))))

(define en-of-fr
  (lambda (french) (car (infer "fast" ((require "en-of-fr.hbs") french)))))

(define phrases
  (list "early bird catches the worm" "spill the beans" "piece of cake"))

(define (round-trip english)
  (define french        (fr-of-en english))
  (define back-to-en    (en-of-fr french))
  (list english french back-to-en))

(map round-trip phrases)`;

async function main() {
  // Load yjs AND y-websocket from plexus's own node_modules so all three
  // (plexus + yjs + y-websocket) share module instances. Mixing copies
  // breaks Plexus.bootstrap's invariant and prevents CRDT update propagation.
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

  // Wait for the relay to settle so we don't fight a remote bootstrap.
  await new Promise<void>((r) => provider.once("synced", () => r()));
  console.log("[ws] synced");

  let project: Project;
  if (doc.share.size === 0) {
    console.log("[bootstrap] doc empty — creating Project + demo program + templates");
    project = ArrivalChain.bootstrap(new Project(), DOC_ID, doc).root;
    project.addFile("fr-of-en.hbs", DEMO_FR_OF_EN_HBS);
    project.addFile("en-of-fr.hbs", DEMO_EN_OF_FR_HBS);
    project.addProgram("demo.scm", DEMO_SCM);
  } else {
    console.log("[bootstrap] doc has state — connecting");
    project = ArrivalChain.connect(doc).root;
  }

  Project.registerBackend("lmstudio", lmstudioBackend(BASE_URL));
  console.log(`[worker] tier=${TIER} → lmstudio:${MODEL} via ${BASE_URL}`);

  // Diagnostic: log every task arrival.
  const { autorun } = await import("mobx");
  autorun(() => {
    const tasks = [...project.tasks.values()];
    if (tasks.length > 0) {
      console.log(`[tasks] count=${tasks.length}:`,
        tasks.map(t => `${t.model}/${t.prompt.slice(0, 30)}=${t.result === null ? "pending" : "done"}`).join("; "));
    }
  });

  const stop = new AbortController();
  process.on("SIGINT", () => { console.log("\n[worker] stopping"); stop.abort(); });

  // Kick off the demo program so tasks get enqueued.
  const entry = [...project.files.values()].at(-1);
  if (entry) {
    entry.run().then(
      (v) => console.log("[program] done:", JSON.stringify(v).slice(0, 200)),
      (e) => console.error("[program] error:", e),
    );
  }

  // Drain forever.
  await runProjectWorker(project, { signal: stop.signal });
  console.log("[worker] exited");
}

main().catch((e) => { console.error(e); process.exit(1); });
