/**
 * Dual-mode test config — THIS IS THE DEFAULT `pnpm test` for plexus. Runs
 * the full suite under both UUID modes because both are legit production
 * configurations exposed to users:
 *
 *   - `feistel`   — encoded, decodable, production default
 *   - `arbitrary` — counter-based, test/tooling path (also surfaced via
 *                   `PLEXUS_UUID_MODE=arbitrary` for consumers that need
 *                   reproducible IDs, e.g. fixture regenerators)
 *
 * Both modes must stay green; a regression in one is a shipping bug. Not a
 * nice-to-have — CI runs it every time.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "feistel",
          globals: true,
          environment: "node",
          include: ["src/__tests__/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "arbitrary",
          globals: true,
          environment: "node",
          include: ["src/__tests__/**/*.test.{ts,tsx}"],
          env: { PLEXUS_UUID_MODE: "arbitrary" },
        },
      },
    ],
  },
});
