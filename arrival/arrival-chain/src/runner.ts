import { ArrivalChain } from "./arrival-chain.js";
import type { ModelBackend } from "./model.js";
import { Project } from "./project.js";
import { runProjectWorker } from "./worker.js";

export interface PublishOptions {
  /** y-websocket relay URL, e.g. `ws://localhost:1235`. */
  wsUrl: string;
  /** Doc id (room) on the relay. The monitor reads from the same. */
  docId: string;
}

export interface RunPipelineOptions {
  /** Map of project-relative path → file content. */
  files: Record<string, string>;
  /** Path of the entry program (must be a key of `files`). */
  entry: string;
  /** Project env. Each entry is path... + value (the runner unfolds it). */
  env?: Record<string, string | number | boolean>;
  /** Tier name → "provider:modelName". Only used if `backends` is a record. */
  models?: Record<string, string>;
  /**
   * Per-run backend override. Three shapes accepted by the worker:
   *   - omitted        — backends come from Project.getBackend(name)
   *   - ModelBackend   — used for every task, bypasses model resolution
   *   - Record<provider, ModelBackend> — keyed by provider name; takes
   *                      precedence over the static registry per provider
   */
  backends?: ModelBackend | Record<string, ModelBackend>;
  /** Optional abort signal to stop running workers + program. */
  signal?: AbortSignal;
  /** If set, also publish the Project's doc over y-websocket. */
  publish?: PublishOptions;
}

/**
 * Self-contained "run this program against this data with these
 * backends" entry point. Used by the CLI script and by tests that
 * exercise the whole substrate top-to-bottom.
 *
 * Bootstraps a fresh in-process Project, populates it from `files`,
 * `env`, and `models`, spawns workers, runs the entry program, then
 * tears the workers down cleanly. Returns whatever the program
 * evaluates to as its last expression.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<unknown> {
  // If publishing is requested, bootstrap on a specific doc id so the
  // monitor can find us. The y-websocket provider is wired up below
  // after the entity classes have registered themselves on the doc.
  let chain;
  let publishProvider: { destroy: () => void } | null = null;
  if (opts.publish) {
    // Lazy import so this module stays usable in environments without
    // a WS implementation (tests, browser).
    const Y = await import("yjs");
    const { WebsocketProvider } = await import("y-websocket");
    const doc = new Y.Doc({ guid: opts.publish.docId });
    chain = ArrivalChain.bootstrap(new Project(), opts.publish.docId, doc);
    publishProvider = new WebsocketProvider(opts.publish.wsUrl, opts.publish.docId, doc) as {
      destroy: () => void;
    };
  } else {
    chain = ArrivalChain.bootstrap(new Project());
  }
  const project = chain.root;

  for (const [path, content] of Object.entries(opts.files)) {
    project.addFile(path, content);
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      project.setEnv(key, value);
    }
  }

  if (opts.models) {
    for (const [tier, providerModel] of Object.entries(opts.models)) {
      const [provider, ...rest] = providerModel.split(":");
      project.setModel(tier, provider, rest.join(":"));
    }
  }

  const ownAc = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? ownAc!.signal;
  const draining = runProjectWorker(project, { backends: opts.backends, signal });

  const entryFile = project.files.get(opts.entry);
  if (!entryFile) throw new Error(`runPipeline: entry "${opts.entry}" is not in files`);
  try {
    return await entryFile.run();
  } finally {
    if (ownAc) ownAc.abort();
    await draining;
    if (publishProvider) {
      try { publishProvider.destroy(); } catch { /* awareness cleanup quirk */ }
    }
  }
}
