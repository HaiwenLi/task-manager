import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Capped, not the default CPU-sized pool: process-tree and cross-process
    // lock fixtures should not compete with a crowd of Node/Git startups on
    // Windows security-filtered disks. Four was measured against two and three
    // (2026-11-25, 24 logical processors): no failure in five runs of each, at
    // a median of 33s, 61s and 43s. Lower it if timings turn flaky on a smaller
    // or busier machine.
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
