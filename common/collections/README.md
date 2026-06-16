# @here.build/collections

Map/WeakMap collection utilities with default-value semantics, plus optional MobX-reactive computed variants.

## Install

```bash
pnpm add @here.build/collections
```

## Usage

```ts
import { DefaultedMap, Counter } from "@here.build/collections";

const groups = new DefaultedMap<string, string[]>(() => []);
groups.get("a").push("x");   // auto-creates the array

const counts = new Counter<string>();
counts.add("hit");
```

- **`DefaultedMap` / `DefaultedWeakMap`** — `get` auto-creates a missing entry from a factory.
- **`Counter`** — tally occurrences.
- **`PathMap`** — tuple/path keys.
- **`ArrayMultimap` / `SetMultimap`** — one key, many values.
- **`/mobx` subpath** — `ComputedMap`, `ComputedWeakMap`, `ComputedUniformMap`: MobX-reactive computed variants.

```ts
import { ComputedMap } from "@here.build/collections/mobx";
```

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
