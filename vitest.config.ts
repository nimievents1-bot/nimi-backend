import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "**/*.module.ts", "**/*.dto.ts", "**/*.spec.ts"],
    },
  },
});
