import { shared } from "@here.build/eslint-configs";

export default [
  ...shared,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Plexus uses nested callbacks for transactional operations (clone, walk, etc.)
      "sonarjs/no-nested-functions": ["error", { threshold: 6 }],
    },
  },
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      // Tests intentionally use console for debugging
      "no-console": "off",
      // Tests often have deeply nested callbacks (describe > it > expect > etc)
      "sonarjs/no-nested-functions": "off",
      // Tests intentionally overwrite elements to verify behavior
      "sonarjs/no-element-overwrite": "off",
      // Tests call constructors to verify they throw
      "sonarjs/constructor-for-side-effects": "off",
      // Tests use destructuring to extract values for assertions, unused parts are fine
      "sonarjs/no-unused-vars": "off",
      "sonarjs/no-dead-store": "off",
      "unicorn/no-useless-undefined": "off",
    },
  },
  { ignores: ["node_modules/*", "dist/*"] },
];
