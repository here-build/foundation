/**
 * Sandbox Security Layer
 *
 * Implements own-property-only access with prototype chain isolation.
 * See docs/sandbox-security-model.md for full design rationale.
 *
 * Core principle: Scheme code can only access what was explicitly put on an object.
 * Inherited properties from built-in prototypes (Object, Array, Function, etc.)
 * are blocked to prevent sandbox escapes.
 */

// ============================================================================
// Sandbox Boundary Marker
// ============================================================================

import invariant from "tiny-invariant";

/**
 * Symbol used to mark classes/prototypes as sandbox boundaries.
 * Any prototype with this symbol (set to true) will block inherited property access.
 *
 * Usage:
 * ```typescript
 * class SecureAPI {
 *   static [SANDBOX_BOUNDARY] = true;
 *   // Methods here won't be accessible via prototype chain from Scheme
 * }
 * ```
 */
// Module-local (NOT Symbol.for): a registry-global symbol is forgeable from
// sandbox via `(make-symbol ...)` / Symbol.for("scheme:sandbox-boundary"),
// which would let hostile code stamp its own boundary markers or strip ours.
// A module-private Symbol is unreachable from outside this module's closure.
export const SANDBOX_BOUNDARY = Symbol("scheme:sandbox-boundary");

const isProduction: boolean = process.env.NODE_ENV === "production";
const prefix: string = "Invariant failed";

declare global {
  interface ErrorConstructor {
    invariant(condition: any, message?: string | (() => string)): asserts condition;
  }
}

Error.invariant = function invariant(condition: any, message?: string | (() => string)): asserts condition {
  if (condition) {
    return;
  }
  if (isProduction) {
    throw new TypeError(prefix);
  }
  const provided: string | undefined = typeof message === "function" ? message() : message;
  const value: string = provided ? `${prefix}: ${provided}` : prefix;
  throw new TypeError(value);
};

// ============================================================================
// Sandbox Violation Error
// ============================================================================

/**
 * Error thrown when Scheme code attempts to access a property
 * that would require crossing a sandbox boundary.
 */
export class SandboxViolationError extends Error {
  constructor(
    message: string,
    public readonly key: string | symbol,
    public readonly boundaryType: string,
  ) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

// ============================================================================
// Built-in Boundaries
// ============================================================================

/**
 * Built-in prototypes that are ALWAYS sandbox boundaries.
 * These are the standard JavaScript built-ins that Scheme code should never access.
 */
const BUILTIN_BOUNDARY_PROTOTYPES: Set<object | null> = new Set([
  Object.prototype,
  Array.prototype,
  Function.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Symbol.prototype,
  RegExp.prototype,
  Date.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  WeakRef.prototype,
  FinalizationRegistry.prototype,
  Promise.prototype,
  Error.prototype,
  // TypedArrays
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
  ArrayBuffer.prototype,
  SharedArrayBuffer.prototype,
  DataView.prototype,
  // Generator/AsyncGenerator function prototypes
  Object.getPrototypeOf(function* () {}).prototype, // GeneratorFunction.prototype
  Object.getPrototypeOf(async function* () {}).prototype, // AsyncGeneratorFunction.prototype
]);

/**
 * Known dangerous property names that should always be blocked,
 * regardless of where they're defined.
 */
const BLOCKED_PROPERTY_NAMES: Set<string> = new Set([
  // Prototype manipulation
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  // Constructor access (can create new objects outside sandbox)
  "constructor",
  // Prototype access
  "prototype",
]);

/**
 * Well-known Symbols that should be blocked from sandbox access.
 * These symbols trigger JS runtime behaviors (type coercion, iteration,
 * instance checks) that could execute arbitrary code or leak internal state.
 */
const BLOCKED_WELL_KNOWN_SYMBOLS: Set<symbol> = new Set([
  Symbol.toPrimitive,
  Symbol.hasInstance,
  Symbol.species,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toStringTag,
  Symbol.unscopables,
  Symbol.isConcatSpreadable,
]);

// ============================================================================
// Boundary Cache
// ============================================================================

/**
 * Cache for prototype boundary status.
 * WeakMap ensures we don't prevent GC of prototypes.
 */
const boundaryCache = new WeakMap<object, boolean>();

/**
 * A prototype whose OWN `constructor` is a global — `globalThis[ctor.name] ===
 * ctor` — is a built-in's prototype, hence a boundary. Generalizes the explicit
 * BUILTIN_BOUNDARY_PROTOTYPES list so we don't enumerate every global (Date,
 * RegExp, Map, the Error subclasses, …). Identity-checked, not name-checked: a
 * hostile `constructor.name = "Object"` still fails, because `globalThis["Object"]`
 * is the REAL Object, not the impostor.
 *
 * The OWN-constructor requirement is the discriminator: built-in AND class
 * prototypes have an own `constructor` (`X.prototype.constructor === X`); an
 * ad-hoc object used as a prototype does NOT — it inherits `Object`, and without
 * this guard would be falsely flagged as a boundary, blocking its own data.
 */
function isGlobalConstructorPrototype(proto: object): boolean {
  // Read `constructor` via its OWN descriptor: own + data-slot only. This both
  // enforces the own-requirement (an ad-hoc prototype inherits `Object` → no own
  // descriptor → undefined) AND hardens the read — a hostile own *accessor*
  // `constructor` is never invoked (no getter fires).
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  if (typeof ctor !== "function" || typeof ctor.name !== "string" || ctor.name.length === 0) return false;
  // Identity, not name: a spoofed `constructor.name` still fails — `globalThis[name]`
  // is the REAL global, not the impostor.
  return (globalThis as Record<string, unknown>)[ctor.name] === ctor;
}

/**
 * Check if a prototype is a sandbox boundary.
 * Results are cached for performance.
 */
export function isSandboxBoundary(proto: object | null): boolean {
  // null = end of chain, always a boundary
  if (proto === null) return true;

  // Check cache first
  const cached = boundaryCache.get(proto);
  if (cached !== undefined) return cached;

  // Check if it's a built-in prototype
  if (BUILTIN_BOUNDARY_PROTOTYPES.has(proto)) {
    boundaryCache.set(proto, true);
    return true;
  }

  // A global constructor's prototype is a boundary — generalizes the explicit
  // list above so any global built-in (incl. ones not enumerated, like the
  // Error subclasses) stops the inheritance walk without being listed.
  if (isGlobalConstructorPrototype(proto)) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Check for explicit boundary marker on the prototype itself (OWN property only)
  // Use hasOwnProperty to avoid inheriting boundary status from parent prototypes
  if (Object.prototype.hasOwnProperty.call(proto, SANDBOX_BOUNDARY) && (proto as Record<symbol, unknown>)[SANDBOX_BOUNDARY] === true) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Check constructor for boundary marker (class-level static property)
  // This allows marking a class as a boundary via `static [SANDBOX_BOUNDARY] = true`.
  // Read via the OWN descriptor (a marked class's prototype has an own
  // `constructor`), so a hostile accessor `constructor` is never invoked.
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  if (ctor && typeof ctor === "function") {
    // Again, use hasOwnProperty to avoid inheritance issues
    if (Object.prototype.hasOwnProperty.call(ctor, SANDBOX_BOUNDARY) && (ctor as unknown as Record<symbol, unknown>)[SANDBOX_BOUNDARY] === true) {
      boundaryCache.set(proto, true);
      return true;
    }
  }

  // Not a boundary
  boundaryCache.set(proto, false);
  return false;
}

/**
 * Mark a class or object as a sandbox boundary.
 * This prevents Scheme code from accessing inherited properties through it.
 */
export function markAsSandboxBoundary(target: object | Function): void {
  (target as unknown as Record<symbol, unknown>)[SANDBOX_BOUNDARY] = true;
  // Invalidate cache — for classes, clear prototype; for plain objects, clear the object itself
  if (typeof target === "function" && target.prototype) {
    boundaryCache.delete(target.prototype);
  } else {
    boundaryCache.delete(target);
  }
}

/**
 * Add a custom blocked property name.
 */
export function blockPropertyName(name: string): void {
  BLOCKED_PROPERTY_NAMES.add(name);
}

// ============================================================================
// Sentinel Value
// ============================================================================

/**
 * Sentinel value indicating a property was not found.
 * This is distinct from `undefined` (which could be a valid property value).
 */
// Module-local (NOT Symbol.for): the not-found sentinel must be unforgeable.
// If it lived in the global registry, sandbox code could mint the same symbol
// and inject it as a "real" property value to spoof the NOT_FOUND signal.
export const NOT_FOUND = Symbol("scheme:not-found");

export type AccessResult<T> = T | typeof NOT_FOUND;

// ============================================================================
// Core Access Functions
// ============================================================================

/**
 * Check if a property name is unconditionally blocked.
 */
function isBlockedPropertyName(key: string | symbol): boolean {
  if (typeof key === "symbol") return BLOCKED_WELL_KNOWN_SYMBOLS.has(key);
  return BLOCKED_PROPERTY_NAMES.has(key);
}

/**
 * Sandboxed field access - the core security primitive.
 *
 * Access rules:
 * 1. Blocked property names (constructor, __proto__, etc.) always throw
 * 2. Own properties are always accessible
 * 3. Missing properties return NOT_FOUND
 * 4. Inherited properties are checked against sandbox boundaries
 *    - If found before hitting a boundary: accessible
 *    - If boundary is hit first: throws SandboxViolationError
 *
 * @param data - The object to access
 * @param key - The property key
 * @returns The property value, or NOT_FOUND if not present
 * @throws SandboxViolationError if access would cross a boundary
 */
export function sandboxedAccess(data: unknown, key: string | symbol): AccessResult<unknown> {
  // Null/undefined have no properties
  if (data === null || data === undefined) {
    return NOT_FOUND;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  // Block dangerous property names unconditionally
  if (isBlockedPropertyName(keyStr)) {
    throw new SandboxViolationError(
      `Cannot access '${String(keyStr)}' - blocked for security`,
      keyStr,
      "blocked-property",
    );
  }

  // For primitives, box them to check properties
  const obj = Object(data);

  // Fast path: own property
  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return Reflect.get(obj, keyStr);
  }

  // Check if property exists anywhere in prototype chain
  if (!Reflect.has(obj, keyStr)) {
    return NOT_FOUND;
  }

  // Property is inherited - trace the prototype chain to find it
  let proto = Reflect.getPrototypeOf(obj);

  while (proto !== null) {
    // Hit a sandbox boundary before finding the property?
    if (isSandboxBoundary(proto)) {
      throw new SandboxViolationError(
        `Cannot access inherited property '${String(keyStr)}' - ` +
          `blocked at sandbox boundary (${proto.constructor?.name || "Object"})`,
        keyStr,
        proto.constructor?.name || "Object",
      );
    }

    // Found it on a non-boundary prototype - allow it
    if (Object.prototype.hasOwnProperty.call(proto, keyStr)) {
      return Reflect.get(obj, keyStr);
    }

    proto = Reflect.getPrototypeOf(proto);
  }

  // Shouldn't reach here (we checked `in` above), but be safe
  return NOT_FOUND;
}

/**
 * Sandboxed property existence check.
 * Only returns true for:
 * - Own properties
 * - Inherited properties from non-boundary prototypes
 *
 * Returns false (not throws) for blocked properties.
 */
export function sandboxedHas(data: unknown, key: string | symbol): boolean {
  // Null/undefined have no properties
  if (data === null || data === undefined) {
    return false;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  // Blocked properties don't "exist" from sandbox perspective
  if (isBlockedPropertyName(keyStr)) {
    return false;
  }

  const obj = Object(data);

  // Fast path: own property
  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return true;
  }

  // Check if property exists anywhere
  if (!Reflect.has(obj, keyStr)) {
    return false;
  }

  // Property is inherited - check if it's accessible
  let proto = Reflect.getPrototypeOf(obj);

  while (proto !== null) {
    // Hit boundary? Property doesn't "exist" from sandbox perspective
    if (isSandboxBoundary(proto)) {
      return false;
    }

    // Found on non-boundary prototype
    if (Object.prototype.hasOwnProperty.call(proto, keyStr)) {
      return true;
    }

    proto = Reflect.getPrototypeOf(proto);
  }

  return false;
}

/**
 * Sandboxed key enumeration.
 * Only returns own enumerable keys - never inherited ones.
 */
export function sandboxedKeys(data: unknown): string[] {
  if (data === null || data === undefined) {
    return [];
  }

  // Object.keys only returns own enumerable string properties - safe
  return Object.keys(Object(data));
}

/**
 * Sandboxed property mutation.
 * Always sets an own property (shadows inherited ones if present).
 */
export function sandboxedSet(data: unknown, key: string | symbol, value: unknown): void {
  TypeError.invariant(data !== null && data !== undefined, "Cannot set property on null/undefined");
  const keyStr = typeof key === "symbol" ? key : String(key);

  // Block setting dangerous property names
  if (isBlockedPropertyName(keyStr)) {
    throw new SandboxViolationError(
      `Cannot set '${String(keyStr)}' - blocked for security`,
      keyStr,
      "blocked-property",
    );
  }

  // Bracket assignment (`data[keyStr] = value`) WALKS the prototype chain and
  // fires inherited setters — so a poisoned `Object.prototype` setter or a
  // `__proto__` assignment escapes the sandbox. `defineProperty` installs an
  // OWN data property unconditionally: no proto-chain walk, no setter invoked,
  // genuinely "own property only" as the contract claims.
  Object.defineProperty(data as object, keyStr, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Sandboxed property deletion.
 * Only deletes own properties, silently ignores inherited ones.
 */
export function sandboxedDelete(data: unknown, key: string | symbol): boolean {
  if (data === null || data === undefined) {
    return false;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  // Can't delete blocked properties
  if (isBlockedPropertyName(keyStr)) {
    return false;
  }

  const obj = data as Record<string | symbol, unknown>;

  // Only delete if it's an own property
  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return Reflect.deleteProperty(obj, keyStr);
  }

  // Silently ignore attempts to delete inherited properties
  return false;
}
