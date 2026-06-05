import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the arrival-chain `/sweet` lens to SOURCE in tests, so a freshly-added
// re-export (parseSexprs/Node) is picked up without rebuilding arrival-chain's dist.
// The lens is runtime-free (imports nothing heavy), so this stays a few-KB closure.
const sweetSrc = fileURLToPath(new URL("../arrival-chain/src/sweet.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@here.build/arrival-chain/sweet": sweetSrc },
  },
});
