# @here.build/arrival-chain-view

A faithful, deterministic projection of an [arrival-chain](../arrival-chain/README.md) Scheme program into a target language — the read-view "glass" over a chain program. JavaScript first; Python next.

Part of the [Arrival](../arrival/README.md) stack.

## Install

```bash
pnpm add @here.build/arrival-chain-view
```

## Usage

```ts
import { projectToJs, compileProject } from "@here.build/arrival-chain-view";

// Project a chain program's scheme into readable JS (the read-view).
const js = projectToJs(program);
```

Entry points:

- `projectToJs` / `projectToJsRaw` — project a program into JS (formatted / raw).
- `projectToPy` — the Python projection.
- `compileProject` — multi-file compile (`CompileTarget`, `EmittedFile`).
- `emitTypes` — emit a TypeScript type view.
- `compilePromptToTs`, `sliceToTypeScript`, `formatJs` — focused helpers.

Subpath exports: `@here.build/arrival-chain-view/browser` (browser-targeted entry) and `@here.build/arrival-chain-view/types-emit`.

The projection is **deterministic and faithful** — the same program always yields the same output, and the output round-trips the program's semantics rather than re-interpreting them.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
