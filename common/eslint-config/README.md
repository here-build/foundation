# @here.build/eslint-configs

Shared ESLint **flat config** presets for Here.build packages.

## Install

```bash
pnpm add -D @here.build/eslint-configs eslint
```

## Usage

Import a named preset into your `eslint.config.mjs`:

```js
import { nodejs } from "@here.build/eslint-configs";

export default [...nodejs];
```

Available presets (each a flat-config array layering the shared base — `@eslint/js`, `typescript-eslint`, `sonarjs`, `unicorn`, `compat`, `import-x`, `promise`, `regexp`, `security`, `prettier` — with env-appropriate globals and browserslist targets):

- `nodejs`
- `browser`
- `shared`
- `cloudflare`
- `landing`
- `reactConfig`

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
