/**
 * Construction sentinels — passed as constructor args to distinguish
 * Plexus-internal construction from user construction.
 *
 * @example
 * // Controlled (hydration/clone):
 * new Model(PLEXUS_CONTROLLED)
 *
 * // Derived (virtual genesis factory):
 * new Model(PLEXUS_DERIVED)
 *
 * // Test sentinel (constructor reachability):
 * Plexus.testSentinels = true;
 * try { new Model(PLEXUS_TEST_SENTINEL); } catch (e) { if (e === PLEXUS_TEST_SENTINEL) ... }
 */

/** Controlled construction — Plexus is driving (hydration, clone, bootstrap). */
export const PLEXUS_CONTROLLED = Symbol.for("Plexus: controlled constructor");

/** Derived construction — virtual genesis factory. Sets `binding: "derived"` on internals. */
export const PLEXUS_DERIVED = Symbol.for("Plexus: derived constructor");

/** Test sentinel — throws itself when `Plexus.testSentinels = true`. For constructor reachability testing. */
export const PLEXUS_TEST_SENTINEL = Symbol("Plexus: test sentinel");
