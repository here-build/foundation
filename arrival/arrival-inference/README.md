# @here.build/arrival-inference

The "talk to LLMs" layer for [Arrival](../arrival/README.md): a model router, provider backends, cost accounting, a single-flight inference cache, and the agentic tool-loop. It knows `ModelSpec` (data) — never the Scheme evaluator.

## Install

```bash
pnpm add @here.build/arrival-inference
```

The provider SDKs are **optional peer dependencies** — install only the ones you use:

```bash
pnpm add @anthropic-ai/sdk   # for the anthropic backend
pnpm add openai              # for the openai-compatible backend
```

## Usage

```ts
import { createInferStore, StaticRouter } from "@here.build/arrival-inference";
import { anthropicBackend } from "@here.build/arrival-inference/backends/anthropic";

const router = new StaticRouter(anthropicBackend({ /* ... */ }));
const store = createInferStore({ router });
```

- **Routers** — `StaticRouter`, `LayeredRouter`, `singletonRouter`, `emptyRouter` map a `ModelSpec` to a backend.
- **`InferStore` / `createInferStore`** — single-flight cache: identical in-flight requests share one call.
- **Backends** — subpath exports for each provider: `./backends/anthropic`, `./backends/openai`, `./backends/openrouter`, `./backends/ollama`, `./backends/vercel`. The `./connectors` subpath exposes lower-level connector plumbing.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
