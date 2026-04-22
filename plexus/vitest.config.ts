import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Regular test configuration
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  }
});
