import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file talks to the same Postgres database and truncates it
    // between tests, so files must not run in parallel with each other.
    // Concurrency *inside* a test is the point; concurrency *between* test
    // files would just make them stomp on each other's data.
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
