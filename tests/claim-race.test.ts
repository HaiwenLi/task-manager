// Race simulation for the takeover path of claim().
//
// Real filesystems only hit this interleaving under contention: W2's
// staleness read completes, then W1's takeover lands (rename/remove +
// possible re-lock) before W2's archive rename runs, so W2's rename gets
// a genuine ENOENT from the real fs layer. claim() must resolve to a
// boolean either way — never reject into the orchestrator's poll loop.
//
// The mock is scoped: it only interferes with rename() calls whose source
// is `race.lockPath`, which only the race tests below ever set.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const race = vi.hoisted(() => ({ lockPath: "", relock: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (src: string, dest: string) => {
      if (src === race.lockPath) {
        // W1's takeover interleaves here: the stale lock disappears…
        await actual.rm(src, { force: true });
        try {
          return await actual.rename(src, dest); // genuine ENOENT — W1 won the archive race
        } catch (err) {
          if (race.relock && (err as NodeJS.ErrnoException).code === "ENOENT") {
            // …and W1 re-locks before W2 gets to create
            await actual.writeFile(src, JSON.stringify({ worker: "w1", heartbeat: Date.now() }), "utf8");
          }
          throw err;
        }
      }
      return actual.rename(src, dest);
    },
  };
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, LOCK_TTL_MS_DEFAULT } from "../src/claim.js";

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), "taskctl-claim-race-"));
  await writeFile(join(tasksDir, "a.md"), "---\nid: a\n---\n", "utf8");
});

afterEach(async () => {
  race.lockPath = "";
  race.relock = false;
  await rm(tasksDir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(tasksDir, "a", "lock.json");
}

async function forgeStaleLock(): Promise<void> {
  await mkdir(join(tasksDir, "a"), { recursive: true });
  await writeFile(lockPath(), JSON.stringify({ worker: "crashed", heartbeat: Date.now() - LOCK_TTL_MS_DEFAULT - 5_000 }), "utf8");
}

describe("claim takeover race", () => {
  it("resolves to true when the stale lock vanishes before our rename (we win the re-create)", async () => {
    await forgeStaleLock();
    race.lockPath = lockPath();
    race.relock = false;

    await expect(claim(tasksDir, "a", "w2")).resolves.toBe(true);

    const lock = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(lock).toMatchObject({ worker: "w2" });
    // Our archive rename lost the race — no stale-* leftovers, just the new lock
    expect(await readdir(join(tasksDir, "a"))).toEqual(["lock.json"]);
  });

  it("resolves to false when the racing worker re-locks first", async () => {
    await forgeStaleLock();
    race.lockPath = lockPath();
    race.relock = true;

    await expect(claim(tasksDir, "a", "w2")).resolves.toBe(false);

    const lock = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(lock).toMatchObject({ worker: "w1" });
  });
});
