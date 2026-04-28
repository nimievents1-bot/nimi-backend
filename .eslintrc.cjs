/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint", "import", "promise", "security"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "plugin:promise/recommended",
    "plugin:security/recommended-legacy",
    "prettier",
  ],
  env: {
    node: true,
    es2022: true,
  },
  settings: {
    "import/resolver": {
      typescript: { alwaysTryTypes: true, project: "./tsconfig.json" },
      node: true,
    },
  },
  rules: {
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/consistent-type-imports": [
      "error",
      { prefer: "type-imports", fixStyle: "inline-type-imports" },
    ],
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "import/order": [
      "error",
      {
        "newlines-between": "always",
        groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
        alphabetize: { order: "asc", caseInsensitive: true },
      },
    ],
    "security/detect-object-injection": "off",
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.spec.ts", "test/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/", "coverage/"],
};
