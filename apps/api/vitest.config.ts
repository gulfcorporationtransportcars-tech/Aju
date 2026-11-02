import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC keeps decorator metadata, which NestJS dependency injection needs.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    globals: true,
    include: ["test/**/*.e2e.test.ts"],
    fileParallelism: false, // one shared test database
    testTimeout: 30000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/luxora_test",
      JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret-123",
    },
    hookTimeout: 60000,
  },
});
