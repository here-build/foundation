# @here.build/arrival-provenance

Read-only provenance analysis for [Arrival](../arrival/README.md): capture a finished evaluation trace, then derive render-models from it. It reads finished traces and **never drives the evaluator**.

## Install

```bash
pnpm add @here.build/arrival-provenance
```

## Usage

```ts
import { computeProvenance, traceToForest } from "@here.build/arrival-provenance";

const provenance = computeProvenance(trace);   // a finished EvalTrace
const forest = traceToForest(trace);
```

The surface, in two halves:

- **Capture** — `EvalTrace`, `Invocation`, `computeProvenance` (dataflow minted at boundaries).
- **Analysis** — turn a finished trace into render-models: a forest, a statechart, a region tree (the studio blueprint) with an incremental `TraceRegionFold`, a flow graph, and the reverse-chain slicer (`buildSlice` / `buildUneval`). Plus `trace-snapshot` / `trace-artifact` serialization.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
