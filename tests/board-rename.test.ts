import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `rename` is replaced here and nowhere else: the retry contract is about which
 * failures are retried, which is invisible when the OS is cooperating.
 */
const state = vi.hoisted(() => ({
  /** One entry per `rename` call: an error to throw, or null to let it through. */
  plan: [] as Array<NodeJS.ErrnoException | null>,
  calls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      state.calls += 1;
      const next = state.plan.shift();
      if (next !== undefined && next !== null) throw next;
      return actual.rename(from, to);
    },
  };
});

const { writeBoard } = await import("../src/board.js");
const { renameWithRetry } = await import("../src/replace.js");

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

let root: string;
let tasksDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-board-rename-"));
  tasksDir = join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  state.plan = [];
  state.calls = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("rename retry policy", () => {
  it("retries a rename the OS refused for a held destination, then succeeds", async () => {
    state.plan = [errno("EPERM"), errno("EBUSY"), errno("EACCES"), null];
    await writeBoard(tasksDir, "# retried\n");
    expect(state.calls).toBe(4);
    expect(await readFile(join(root, ".taskctl", "board.md"), "utf8")).toBe("# retried\n");
    expect((await readdir(join(root, ".taskctl"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not retry failures that are not about a busy destination", async () => {
    state.plan = [errno("ENOENT"), null];
    await expect(renameWithRetry(join(root, "missing.tmp"), join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.calls).toBe(1);
  });

  it("gives up after the bounded number of retries instead of looping", async () => {
    vi.useFakeTimers();
    state.plan = Array.from({ length: 20 }, () => errno("EPERM"));
    const attempt = renameWithRetry(join(root, "a.tmp"), join(root, "b"));
    const settled = expect(attempt).rejects.toMatchObject({ code: "EPERM" });
    // 1 initial call + the declared retries; the schedule is 5/25/125/625/3125ms.
    await vi.advanceTimersByTimeAsync(5 + 25 + 125 + 625 + 3_125);
    await settled;
    expect(state.calls).toBe(6);
    vi.useRealTimers();
  });
});
