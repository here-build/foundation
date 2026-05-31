import { ArrivalChain } from "./arrival-chain.js";
import { ArrivalCache, InferenceCache } from "./cache.js";
import type { ModelRouter } from "./registry.js";
import { Project } from "./project.js";
import { startOrchestrator } from "./worker.js";

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
  /** Model-id → backend lookup (required). Construct via `StaticRouter`, `LayeredRouter`, or `singletonRouter`. */
  router: ModelRouter;
  /** Optional abort signal to stop running workers + program. */
  signal?: AbortSignal;
  /** Optional wall-clock budget (ms) for program evaluation. Composes with
   *  `signal` (first to fire wins); cut at the evaluator's TICK boundary. */
  budgetMs?: number;
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
 * binds them, populates from `files` (config-as-code: per-run config lives
 * in a `config.scm` file the entry requires), spawns a worker, runs the entry
 * program, then tears the worker down cleanly. Returns whatever the program
 * evaluates to as its last expression.
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

  const ownAc = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? ownAc!.signal;
  const orch = startOrchestrator({ cache, router: opts.router, signal });
  const draining = orch.done;

  const entryFile = project.files.get(opts.entry);
  if (!entryFile) throw new Error(`runPipeline: entry "${opts.entry}" is not in files`);
  try {
    return await entryFile.run({ signal, budgetMs: opts.budgetMs });
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
