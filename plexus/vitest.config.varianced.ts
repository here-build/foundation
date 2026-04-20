import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "feistel",
          globals: true,
          environment: "node",
          include: ["./src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "arbitrary",
          globals: true,
          environment: "node",
          include: ["./src/**/*.test.ts"],
          env: { PLEXUS_UUID_MODE: "arbitrary" },
        },
      },
    ],
  },
});
