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
          allowDefaultProject: ["src/__tests__/*.ts", "src/__benchmarks__/*.ts"],
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
      // Interpreter code is inherently complex
      "sonarjs/cognitive-complexity": "off",
      // PascalCase files are intentional for classes (SchemeString, Pair, etc.)
      "unicorn/filename-case": "off",
      // Lisp interpreter needs Function type for dynamic dispatch
      "@typescript-eslint/no-unsafe-function-type": "off",
      // `this` aliasing is common pattern in ported code
      "unicorn/no-this-assignment": "off",
      "@typescript-eslint/no-this-alias": "off",
      // Static properties in interpreter classes shouldn't be readonly
      "sonarjs/public-static-readonly": "off",
      // Regex patterns are core to parser, timing attacks not a concern
      "security/detect-possible-timing-attacks": "off",
      "security/detect-non-literal-regexp": "off",
      // Move functions is impractical for this codebase
      "unicorn/consistent-function-scoping": "off",
      // In dynamic Lisp code, || is often intentional for falsy handling
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      // Type narrowing in interpreter is complex, these are often false positives
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Stylistic regex preferences - code works fine
      "unicorn/prefer-regexp-test": "off",
      "sonarjs/prefer-regexp-exec": "off",
      // Regex complexity is inherent to parser
      "sonarjs/slow-regex": "off",
      "security/detect-unsafe-regex": "off",
      // Allow unused vars with underscore prefix (intentionally unused)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Import order is less critical in interpreter code
      "import-x/order": "off",
      // Loop counter updates in interpreter are intentional
      "sonarjs/updated-loop-counter": "off",
    },
  },
  {
    ignores: ["node_modules/*", "dist/*", "**/*.config.*", "debug-*.ts", "lib/**", "vendor/**", "src/__benchmarks__/**", "src/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
  },
];
