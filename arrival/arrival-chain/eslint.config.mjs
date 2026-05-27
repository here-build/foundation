import { nodejs } from "@here.build/eslint-configs";
import { fileURLToPath } from "node:url";
import path from "path";

// eslint-disable-next-line unicorn/no-negated-condition,unicorn/prefer-module
const dirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export default [
  ...nodejs,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          defaultProject: "tsconfig.test.json",
          allowDefaultProject: [
            "src/__tests__/*.test.ts",
            "src/__research__/*.test.ts",
            "src/__custdev__/*.test.ts",
          ],
        },
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    files: [
      "src/__tests__/**/*.ts",
      "src/__research__/**/*.ts",
      "src/__custdev__/**/*.ts",
      "src/**/*.test.ts",
    ],
    rules: {
      "no-console": "off",
      "sonarjs/no-nested-functions": "off",
      "sonarjs/no-element-overwrite": "off",
      "sonarjs/no-unused-vars": "off",
      "sonarjs/no-dead-store": "off",
      "unicorn/no-useless-undefined": "off",
      "unicorn/consistent-function-scoping": "off",
      "sonarjs/assertions-in-tests": "off",
    },
  },
  {
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='invariant'][arguments.length<2]",
          message: "`invariant` must always be invoked with a message.",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "sonarjs/function-return-type": "off",
      "no-console": "off",
    },
  },
  {
    ignores: [
      "node_modules/*",
      "dist/*",
      "**/*.config.*",
      "scripts-*.ts",
    ],
  },
];
