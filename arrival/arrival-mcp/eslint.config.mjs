import { nodejs } from "@here.build/eslint-configs";

export default [
  ...nodejs,
  // Tooling / experiment files that aren't part of the typed src project (the projectService can't
  // resolve them → parse errors): the vitest config and the __research__ scratch stubs.
  { ignores: ["vitest.config.ts", "src/__research__/**"] },
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Redundant with @typescript-eslint/no-unused-vars, which honors the `^_` discard convention
      // (sonarjs's copy does not, so it false-flags intentional `{ x: _, ...rest }` destructure drops).
      "sonarjs/no-unused-vars": "off",
      // This package names its class-modules in PascalCase (DiscoveryTool.ts, ActionTool.ts, …) —
      // the established convention; allow it alongside camel/kebab.
      "unicorn/filename-case": ["error", { cases: { camelCase: true, pascalCase: true, kebabCase: true } }],
    },
  },
];
