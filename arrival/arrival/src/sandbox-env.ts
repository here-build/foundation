/**
 * @deprecated Compat shim — import from `./inference-env.js` instead.
 *
 * The "sandbox" framing was wrong: this is the inference-plane base env (the
 * totalic env where models author and evaluate Scheme), not a security fence.
 * The module was renamed `sandbox-env` → `inference-env` and its export
 * `sandboxedEnv` → `inferenceEnv`. This shim re-exports the new surface (both
 * `inferenceEnv` and the deprecated `sandboxedEnv` alias) so in-package path
 * importers keep compiling through the migration window; it is removed once every
 * importer is codemodded to `./inference-env.js`.
 */

export * from "./inference-env.js";
