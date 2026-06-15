/**
 * @deprecated Compat shim — import from `./interop-access.js` instead.
 *
 * The "sandbox" framing was wrong: this is the polyglot membrane's MEMBER-ACCESS
 * policy (own-data-only reads), not a security fence around a guest. The module
 * was renamed `sandbox-boundary` → `interop-access` and its symbols re-framed
 * (`sandboxedAccess` → `accessMember`, `SANDBOX_BOUNDARY` → `INTEROP_BOUNDARY`,
 * `markAsSandboxBoundary` → `markInteropBoundary`, …). This shim re-exports the new
 * surface under the old names so importers keep compiling through the migration
 * window; it is removed once every importer is codemodded to `interop-access`.
 */

export * from "./interop-access.js";
export {
  markInteropBoundary as markAsSandboxBoundary,
  markInteropPrivate as markSandboxPrivate,
  isInteropBoundary as isSandboxBoundary,
  InteropAccessError as SandboxViolationError,
  INTEROP_BOUNDARY as SANDBOX_BOUNDARY,
  accessMember as sandboxedAccess,
  accessHas as sandboxedHas,
  accessKeys as sandboxedKeys,
  accessSet as sandboxedSet,
  accessDelete as sandboxedDelete,
} from "./interop-access.js";
