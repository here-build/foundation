import { ArrivalChain } from "./arrival-chain.js";
import { ArrivalCache, InferenceCache } from "./cache.js";
import type { ModelBackend } from "./model.js";
import { Project } from "./project.js";
import { runWorker } from "./worker.js";

export interface PublishOptions {
  /** y-websocket relay URL, e.g. `ws://localhost:1235`. */
  wsUrl: string;
  /** Doc id (room) for the Project doc on the relay. */
  projectDocId: string;
  /** Doc id (room) for the InferenceCache doc on the relay. */
  cacheDocId: string;
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
  /** If set, also publish both Project and InferenceCache docs over y-websocket. */
  publish?: PublishOptions;
}

interface Disposable {
  destroy: () => void;
}

/**
 * Self-contained "run this program against this data with these
 * backends" entry point. Used by the CLI script and by tests that
 * exercise the whole substrate top-to-bottom.
 *
 * Bootstraps a fresh in-process Project + InferenceCache (one of each),
 * binds them, populates from `files` / `env` / `models`, spawns a
 * worker, runs the entry program, then tears the worker down cleanly.
 * Returns whatever the program evaluates to as its last expression.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<unknown> {
  let chain;
  let cacheChain;
  let publishProviders: Disposable[] = [];

  if (opts.publish) {
    // Lazy imports so this module stays usable in environments without
    // a WS implementation (tests, browser).
    const Y = await import("yjs");
    const { WebsocketProvider } = await import("y-websocket");

    const projectDoc = new Y.Doc({ guid: opts.publish.projectDocId });
    chain = ArrivalChain.bootstrap(new Project(), opts.publish.projectDocId, projectDoc);

    const cacheDoc = new Y.Doc({ guid: opts.publish.cacheDocId });
    cacheChain = ArrivalCache.bootstrap(new InferenceCache(), opts.publish.cacheDocId, cacheDoc);

    publishProviders = [
      new WebsocketProvider(opts.publish.wsUrl, opts.publish.projectDocId, projectDoc) as Disposable,
      new WebsocketProvider(opts.publish.wsUrl, opts.publish.cacheDocId, cacheDoc) as Disposable,
    ];
  } else {
    chain = ArrivalChain.bootstrap(new Project());
    cacheChain = ArrivalCache.bootstrap(new InferenceCache());
  }

  const project = chain.root;
  const cache = cacheChain.root;
  project.bindCache(cache);

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
  const draining = runWorker({ project, cache, backends: opts.backends, signal });

  const entryFile = project.files.get(opts.entry);
  if (!entryFile) throw new Error(`runPipeline: entry "${opts.entry}" is not in files`);
  try {
    return await entryFile.run();
  } finally {
    if (ownAc) ownAc.abort();
    await draining;
    for (const provider of publishProviders) {
      try {
        provider.destroy();
      } catch {
        /* awareness cleanup quirk */
      }
    }
  }
}
