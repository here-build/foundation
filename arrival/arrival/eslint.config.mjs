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
    // Arrival-specific overrides - package is WIP, be more lenient
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='invariant'][arguments.length!=2]",
          message: "`invariant` must always be invoked with a message.",
        },
      ],
      // Lisp implementation needs 'any' for dynamic typing
      "@typescript-eslint/no-explicit-any": "off",
      // Many functions in Lisp are inherently flexible return types
      "sonarjs/function-return-type": "off",
      "no-console": "off",
    },
  },
  {
    ignores: ["node_modules/*", "dist/*", "**/*.config.*"],
  },
];
