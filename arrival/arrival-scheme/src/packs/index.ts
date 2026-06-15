/**
 * Environment Packs
 *
 * Pre-built modules for common use cases.
 * Import only what you need for automatic tree-shaking.
 *
 * @example
 * ```typescript
 * import { createSandbox } from '@here.build/arrival-scheme/sandbox';
 * import { createLipsExtensionsPack } from '@here.build/arrival-scheme/packs';
 *
 * const sandbox = await createSandbox({
 *   packs: [await createLipsExtensionsPack()]
 * });
 * ```
 */

export {
  createLipsExtensionsPack as createLipsExtensionsPack,
  LIPS_EXTENSION_BINDINGS as LIPS_EXTENSION_BINDINGS,
} from "./lips-extensions.js";
