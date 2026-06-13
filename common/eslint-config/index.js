import eslint from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import compat from "eslint-plugin-compat";
import importX from "eslint-plugin-import-x";
import jest from "eslint-plugin-jest";
import noSecrets from "eslint-plugin-no-secrets";
import promise from "eslint-plugin-promise";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import * as regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

const baseConfig = [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/build/**", "**/.next/**", "eslint.config.*"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  sonarjs.configs.recommended,
  unicorn.configs["flat/recommended"],
  compat.configs["flat/recommended"],
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  promise.configs["flat/recommended"],
  regexp.configs["flat/recommended"],
  {
    plugins: {
      "no-secrets": noSecrets,
    },
    rules: {
      "no-secrets/no-secrets": [
        "error",
        {
          ignoreContent: [/https?:\/\/[^ ]+/],
        },
      ],
    },
  },
  security.configs.recommended,
  {
    rules: {
      // Stylistic rules - should be warnings, not errors
      "arrow-body-style": "warn",
      "@typescript-eslint/consistent-type-imports": "off",

      // Performance and best practices
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/prefer-readonly": "warn",

      // Critical async/await rules - these should be errors
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-new": "error",

      // Type safety — default case satisfies exhaustiveness (supports switch(true) pattern)
      "@typescript-eslint/switch-exhaustiveness-check": ["error", {
        considerDefaultExhaustiveForUnions: true,
      }],
      "@typescript-eslint/no-shadow": "error",

      // Unused vars with _ prefix ignore pattern
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // TypeScript relaxations - reasonable defaults
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-empty-interface": "warn",

      // Allow empty catch blocks
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Assertion message requirements
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='ensure'][arguments.length<2]",
          message: "`ensure` must always be invoked with a message.",
        },
        {
          selector: "CallExpression[callee.name='assert'][arguments.length<2]",
          message: "`assert` must always be invoked with a message.",
        },
        {
          selector: "CallExpression[callee.name='invariant'][arguments.length<2]",
          message: "`invariant` must always be invoked with a message.",
        },
      ],

      // Code quality improvements
      "prefer-const": "warn",
      "no-var": "error",
      "object-shorthand": "warn",
      "prefer-template": "warn",
      "no-console": "warn", // Should be removed before production

      // Import organization
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", ["parent", "sibling"], "index", "object"],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
          pathGroups: [
            {
              pattern: "react",
              group: "external",
              position: "before",
            },
            {
              pattern: "react-dom/**",
              group: "external",
              position: "before",
            },
            {
              pattern: "@/**",
              group: "internal",
              position: "before",
            },
          ],
          pathGroupsExcludedImportTypes: ["react", "react-dom"],
          distinctGroup: false,
          warnOnUnassignedImports: true,
        },
      ],
      "import-x/first": "error",
      "import-x/newline-after-import": "error",
      // `prefer-inline` is load-bearing, not cosmetic: without it, the autofix that merges
      // multiple imports from one module hoists everything into `import type { … }` and drags
      // VALUE specifiers in with it — producing invalid `import type { …, aValue }` (TS2206/
      // TS1361). Inline `type` markers keep values as values. (eslint-plugin-import-x ≤4.16.2.)
      "import-x/no-duplicates": ["error", { "prefer-inline": true }],
      "import-x/no-useless-path-segments": "off",
      "import-x/no-relative-packages": "error",

      // Existing rules
      "security/detect-object-injection": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-dom-node-append": "off",
      "unicorn/prefer-top-level-await": "off",
      "sonarjs/todo-tag": "off",
      "import-x/no-named-as-default": "off",
      "import-x/namespace": "off", // acts weirdly
      "sonarjs/void-use": "off", // https://github.com/SonarSource/SonarJS/issues/2629
      "sonarjs/no-invalid-await": "off",
      "sonarjs/different-types-comparison": "off",
      "regexp/strict": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/no-array-for-each": "warn",
      "unicorn/no-array-reduce": "off",
      "unicorn/switch-case-braces": "off",
      "unicorn/no-useless-fallback-in-spread": "off",
      "sonarjs/prefer-read-only-props": "off",
      "sonarjs/use-type-alias": "off", // too many faults on generics
      "sonarjs/no-redundant-jump": "off",
      // "sonarjs/deprecation": "warn",
      "unicorn/prefer-global-this": "off",
      "sonarjs/cognitive-complexity": "warn", // intentionally noisy — each violation should be explicitly acknowledged
      "sonarjs/no-nested-conditional": "warn",
      "sonarjs/no-commented-code": "off", //heavy ESLint performance impact
      "sonarjs/deprecation": "off", //heavy ESLint performance impact
      "sonarjs/arguments-order": "off", //heavy ESLint performance impact
      "@typescript-eslint/no-misused-promises": "off", //heavy ESLint performance impact
      "unicorn/no-useless-undefined": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/filename-case": [
        "warn", // Changed from error to warn
        {
          cases: {
            camelCase: true,
            kebabCase: true,
          },
        },
      ],
    },
  },
  {
    files: ["**/*.jsx", "**/*.tsx"],
    rules: {
      "unicorn/filename-case": [
        "warn", // Changed from error to warn
        {
          cases: {
            camelCase: true,
            kebabCase: true,
            pascalCase: true,
          },
        },
      ],
    },
  },
  {
    // update this to match your test files
    files: [
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*-spec.ts",
      "**/*-spec.tsx",
      "**/*.test.js",
      "**/*.test.jsx",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/test/**/*",
      "**/__mocks__/**/*",
    ],
    plugins: { jest: jest },
    languageOptions: {
      globals: jest.environments.globals.globals,
    },
    rules: {
      "jest/no-disabled-tests": "warn",
      "jest/no-focused-tests": "error",
      "jest/no-identical-title": "error",
      "jest/prefer-to-have-length": "warn",
      "jest/valid-expect": "error",
    },
  },
  prettierRecommended,
].flat();

const browserRelatedRules = {
  rules: {
    "import-x/no-dynamic-require": "warn",
    "import-x/no-nodejs-modules": "warn"
  }
};

export const reactConfig = [
  react.configs.flat.recommended,
  {
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      ...reactHooks.configs.recommended.rules,

      // React stylistic rules - warnings not errors
      "react/jsx-no-useless-fragment": "warn",
      "react/jsx-boolean-value": ["warn", "never", { assumeUndefinedIsFalse: false, always: ["initialValue"] }],
      "react/jsx-curly-brace-presence": "warn",
      "react/self-closing-comp": "warn",

      // React best practices - warnings for maintainability
      "react/no-array-index-key": "warn",
      "react/no-danger": "warn",
      "react/no-unused-prop-types": "warn",

      // Security-related React rules - keep as errors
      "react-hooks/exhaustive-deps": ["warn", {
        additionalHooks: "(useTransactionalCallback|useTransactionalEffect|useComputedValue|useAutorunEffect|useReactionEffect)"
      }]
    }
  },
  browserRelatedRules
];

export const nodejs = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    settings: {
      browserslistOpts: { env: "node" },
    },
  },
  ...baseConfig,
];

export const browser = [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      browserslistOpts: { env: "browser" },
    },
  },
  ...baseConfig,
  ...reactConfig,
];

export const shared = [
  {
    languageOptions: {
      globals: {
        ...globals["shared-node-browser"],
      },
    },
    settings: {
      browserslistOpts: { env: "node" },
    },
  },
  ...baseConfig,
  ...reactConfig,
];

export const cloudflare = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    settings: {
      browserslistOpts: { env: "cf" },
    },
  },
  ...baseConfig,
];

export const landing = [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      browserslistOpts: { env: "browser-widespread" },
    },
  },
  ...baseConfig,
  ...reactConfig,
];
