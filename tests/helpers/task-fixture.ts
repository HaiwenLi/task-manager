import type { Task, TaskComplexity, TaskRisk, TaskStatus } from "../../src/task-file.js";

/** A complete, valid Task with sensible defaults; override only what a test is about. */
export function buildTaskFile(overrides: Partial<Task> & { id: string; title?: string } = { id: "001" }): Task {
  const status: TaskStatus = overrides.status ?? "open";
  const complexity: TaskComplexity = overrides.complexity ?? "complex";
  const risk: TaskRisk = overrides.risk ?? "normal";
  return {
    description: "",
    criteria: [],
    workdir: undefined,
    dependsOn: [],
    humanCheck: false,
    tolerate: [],
    reviewRounds: 0,
    sessions: [],
    retries: 0,
    ...overrides,
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    status,
    complexity,
    risk,
  };
}
