import { nodejs } from "@here.build/eslint-configs";
import { fileURLToPath } from "node:url";
import path from "path";

// @ts-expect-error todo
// eslint-disable-next-line unicorn/no-negated-condition,unicorn/prefer-module
const dirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export default [
  ...nodejs,
  {
    files: ["src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    // Test files - relaxed TypeScript project service
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        },
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    // Scheme-specific overrides - Lisp implementation needs flexibility
    rules: {
      // Lisp implementation needs 'any' for dynamic typing
      "@typescript-eslint/no-explicit-any": "off",
      // Many functions in Lisp are inherently flexible return types
      "sonarjs/function-return-type": "off",
      // Console allowed for REPL/debugging
      "no-console": "off",
    },
  },
  {
    ignores: ["node_modules/*", "dist/*", "**/*.config.*"],
  },
];
