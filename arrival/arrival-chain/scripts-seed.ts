// Seeds a y-websocket doc with a tiny arrival-chain project so the monitor's
// trace view has a file to run against. Pre-seeds two infer tasks as resolved
// so the trace lights up immediately when "Run with trace" is clicked.
import { ArrivalChain, Project, InferenceResult } from "@here.build/arrival-chain";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import ws from "ws";

async function main() {
  const DOC_ID = "trace-demo";
  const doc = new Y.Doc();
  (globalThis as { WebSocket?: unknown }).WebSocket ??= ws;
  const provider = new WebsocketProvider("ws://localhost:1235", DOC_ID, doc, { WebSocketPolyfill: ws as never });
  provider.on("status", (e: { status: string }) => console.log("ws status:", e.status));
  provider.on("synced", () => console.log("synced"));

  console.log("bootstrapping locally…");
  const project = ArrivalChain.bootstrap(new Project()).root;

  project.addProgram(
    "demo.scm",
    `(list
  (car (infer "fast" "hello"))
  (car (infer "fast" "world"))
  (+ 1 2))`,
  );

  project.upsertTask("fast", "hello", null).result = new InferenceResult({ valueJson: '"HELLO"' });
  project.upsertTask("fast", "world", null).result = new InferenceResult({ valueJson: '"WORLD"' });

  console.log(`bootstrapped doc=${DOC_ID}. open http://localhost:5273?doc=${DOC_ID}`);
  setInterval(() => {}, 60_000);
}
main().catch((e) => { console.error(e); process.exit(1); });
