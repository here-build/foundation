import { shared } from "@here.build/eslint-configs";

export default [
  ...shared,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
];
