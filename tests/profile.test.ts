import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendObservation, profilePath, readProfile } from "../src/profile.js";

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taskctl-profile-"));
  const tasksDir = join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  return tasksDir;
}

describe("profile", () => {
  it("reads null when there is no profile yet", async () => {
    const tasksDir = await setup();
    expect(await readProfile(tasksDir)).toBeNull();
  });

  it("creates the file on the first observation and keeps both entries", async () => {
    const tasksDir = await setup();
    await appendObservation(tasksDir, "偏好短句，不要寒暄");
    await appendObservation(tasksDir, "交付物先给结论再给证据");

    const text = await readProfile(tasksDir);
    expect(text).toContain("偏好短句，不要寒暄");
    expect(text).toContain("交付物先给结论再给证据");
    expect(await readFile(profilePath(tasksDir), "utf8")).toBe(text);
  });

  it("keeps the file readable and append-only", async () => {
    const tasksDir = await setup();
    await appendObservation(tasksDir, "第一条");
    const first = await readFile(profilePath(tasksDir), "utf8");
    await appendObservation(tasksDir, "第二条");
    const second = await readFile(profilePath(tasksDir), "utf8");
    expect(second.startsWith(first)).toBe(true);
  });
});
