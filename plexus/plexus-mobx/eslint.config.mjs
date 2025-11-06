import { plugins, shared, tseslint } from "@here.build/eslint-configs";
import globals from "globals";
import { fileURLToPath } from "node:url";
import path from "path";

// @ts-expect-error todo
// eslint-disable-next-line unicorn/no-negated-condition,unicorn/prefer-module
const dirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const testFiles = [
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*-spec.ts",
  "**/*-spec.tsx",
  "**/*.stories.tsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/test/**/*",
  "**/__mocks__/**/*",
];

export default [
  ...shared,
  {
    rules: {
      "no-async-promise-executor": "off",
      "unicorn/prefer-node-protocol": "off",
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='ensure'][arguments.length!=2]",
          message: "`ensure` must always be invoked with a message.",
        },
        {
          selector: "CallExpression[callee.name='assert'][arguments.length!=2]",
          message: "`assert` must always be invoked with a message.",
        },
        {
          selector: "CallExpression[callee.name='invariant'][arguments.length!=2]",
          message: "`invariant` must always be invoked with a message.",
        },
      ],
      "no-debugger": "off",
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      "no-extra-boolean-cast": "off",
      "@typescript-eslint/triple-slash-reference": [
        "error",
        {
          types: "always",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-floating-promises": ["error", {}],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
            arguments: false,
          },
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-empty-interface": "warn",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: testFiles,
        },
      ],
      "promise/no-return-wrap": "error",
      "promise/param-names": "warn",
      "unicorn/consistent-function-scoping": "error",
      "unicorn/empty-brace-spaces": "error",
      "unicorn/error-message": "error",
      "unicorn/escape-case": "error",
      "unicorn/expiring-todo-comments": "error",
      "unicorn/explicit-length-check": "error",
      "unicorn/import-style": "error",
      "unicorn/new-for-builtins": "error",
      "unicorn/no-array-method-this-argument": "error",
      "unicorn/no-array-push-push": "warn",
      "unicorn/no-console-spaces": "error",
      "unicorn/no-document-cookie": "error",
      "unicorn/no-empty-file": "error",
      "unicorn/no-for-loop": "warn",
      "unicorn/no-hex-escape": "error",
      "unicorn/no-instanceof-array": "error",
      "unicorn/no-invalid-remove-event-listener": "error",
      "unicorn/no-new-array": "error",
      "unicorn/no-new-buffer": "error",
      "unicorn/no-object-as-default-parameter": "error",
      "unicorn/no-process-exit": "off",
      "unicorn/no-static-only-class": "error",
      "unicorn/no-thenable": "error",
      "unicorn/no-this-assignment": "error",
      "unicorn/no-unreadable-array-destructuring": "error",
      "unicorn/no-unreadable-iife": "error",
      "unicorn/no-useless-length-check": "warn",
      "unicorn/no-useless-promise-resolve-reject": "warn",
      "unicorn/no-useless-spread": "warn",
      "unicorn/no-useless-switch-case": "warn",
      "unicorn/no-zero-fractions": "error",
      "unicorn/number-literal-case": "error",
      "unicorn/prefer-add-event-listener": "warn",
      "unicorn/prefer-array-find": "warn",
      "unicorn/prefer-array-flat": "warn",
      "unicorn/prefer-array-flat-map": "warn",
      "unicorn/prefer-array-index-of": "warn",
      "unicorn/prefer-array-some": "warn",
      "unicorn/relative-url-style": "error",
      "unicorn/require-array-join-separator": "error",
      "unicorn/require-number-to-fixed-digits-argument": "error",
      "unicorn/template-indent": "error",
      "unicorn/throw-new-error": "error",
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    ignores: [".storybook/*", "node_modules/*", "dist/*", "lib/*", "**/*.config.*"],
  },
];