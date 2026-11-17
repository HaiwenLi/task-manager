import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBoard } from "../src/board.js";

/** A fresh `tasks/` dir plus its parent, so `.taskctl/` has somewhere to land. */
async function scaffold(): Promise<{ root: string; tasksDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "taskctl-board-stress-"));
  const tasksDir = join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  return { root, tasksDir };
}

describe("writeBoard under contention", () => {
  /**
   * The failure this test exists for: on Windows `rename` onto a board another
   * process is reading fails with EPERM instead of waiting, so two terminals
   * running `taskctl board` made the file intermittently unwritable (2 of 10
   * runs). Eight writers × 50 rounds is the same collision, held open.
   */
  it("lands every write when 8 writers race for 50 rounds, and leaves no tmp behind", async () => {
    const { root, tasksDir } = await scaffold();
    const path = join(root, ".taskctl", "board.md");

    for (let round = 0; round < 50; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_unused, writer) => writeBoard(tasksDir, `# round ${round} writer ${writer}\n`)),
      );
    }

    const names = await readdir(join(root, ".taskctl"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names).toContain("board.md");
    // Whoever wrote last, the file is one complete board — never a splice of two.
    expect(await readFile(path, "utf8")).toMatch(/^# round 49 writer [0-7]\n$/);
  }, 120_000);

  it("still writes a single board when nothing contends", async () => {
    const { root, tasksDir } = await scaffold();
    const path = await writeBoard(tasksDir, "# alone\n");
    expect(await readFile(path, "utf8")).toBe("# alone\n");
    expect(path).toBe(join(root, ".taskctl", "board.md"));
  });
});
