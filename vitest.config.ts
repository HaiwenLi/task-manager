import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Process-tree and cross-process lock fixtures should not compete with a
    // CPU-sized pool of Node/Git startups on Windows security-filtered disks.
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});
