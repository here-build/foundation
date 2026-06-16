# @here.build/error-invariant

A side-effect import that installs a global `Error.invariant(condition, message)` assertion helper.

## Install

```bash
pnpm add @here.build/error-invariant
```

## Usage

Import once (for the side effect) — typically at an entry point:

```ts
import "@here.build/error-invariant";

Error.invariant(user != null, "user is required");
// throws an Error when the condition is falsy

TypeError.invariant(typeof x === "number", "x must be a number");
// throws a TypeError — the *receiver's* type
```

`invariant` resolves on `Error` and every subclass via the constructor prototype chain, and throws an instance of the constructor it was called on (`MyError.invariant(...)` throws a `MyError`). When the condition holds, it narrows the type for the rest of the scope.

> ⚠️ **Global side effect.** Importing this package mutates the global `Error` constructor (and its subclasses). That is its entire purpose — do not configure your bundler to tree-shake the import away.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
