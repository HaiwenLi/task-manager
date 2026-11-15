import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HEADER = [
  "# 用户偏好档案",
  "",
  "> 由 `taskctl learn` 或人工追加。澄清与复核会话会读到全文，所以只写能指导动作的规则，",
  "> 不要写对话摘要。改错了直接删那一行，下次不再读它。",
  "",
  "## 观察",
  "",
].join("\n");

/** `.taskctl/profile.md` next to the tasks dir — readable, editable, not state. */
export function profilePath(tasksDir: string): string {
  return join(tasksDir, "..", ".taskctl", "profile.md");
}

/** The profile text, or `null` when nothing has been recorded yet. */
export async function readProfile(tasksDir: string): Promise<string | null> {
  try {
    return await readFile(profilePath(tasksDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Append one observation ("原话 → 改法"). Append-only so a wrong note can be
 * deleted by hand without losing the rest, and so every rule has a visible date.
 */
export async function appendObservation(tasksDir: string, note: string): Promise<string> {
  const path = profilePath(tasksDir);
  await mkdir(join(path, ".."), { recursive: true });
  const line = `- ${new Date().toISOString().slice(0, 10)}  ${note.trim()}\n`;
  try {
    await readFile(path, "utf8");
    await appendFile(path, line, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeFile(path, `${HEADER}${line}`, "utf8");
  }
  return path;
}
