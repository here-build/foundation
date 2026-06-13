import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the `@here.build/arrival-sweet` lens to SOURCE in tests, so a freshly-added
// re-export (parseSexprs/Node) is picked up without rebuilding the package's dist.
// The lens is a runtime-free leaf (its own S-expr parser; only tiny-invariant).
const sweetSrc = fileURLToPath(new URL("../arrival-sweet/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@here.build/arrival-sweet": sweetSrc },
  },
});
