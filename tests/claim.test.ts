import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, heartbeat, isStale, lockLive, release, withOwnership, OwnershipLostError, LOCK_TTL_MS_DEFAULT } from "../src/claim.js";

const openMd = `---
id: a
title: 任务A
status: open
sessions: []
retries: 0
---
A 的正文`;

const runningMd = `---
id: a
title: 任务A
status: running
sessions: ["ses-1"]
retries: 0
---
A 的正文`;

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), "taskctl-claim-"));
  await writeFile(join(tasksDir, "a.md"), openMd, "utf8");
});

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(tasksDir, "a", "lock.json");
}

async function readLock(): Promise<{ worker: string; heartbeat: number }> {
  return JSON.parse(await readFile(lockPath(), "utf8")) as { worker: string; heartbeat: number };
}

/** Overwrite the lock with a forged heartbeat, bypassing the API. */
async function forgeLock(worker: string, heartbeat: number): Promise<void> {
  await mkdir(join(tasksDir, "a"), { recursive: true });
  await writeFile(lockPath(), JSON.stringify({ worker, heartbeat }), "utf8");
}

describe("claim", () => {
  it("serializes contending stale takeovers so only one generation wins", async () => {
    await forgeLock("old", Date.now() - 60_000);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(tasksDir, "a", `new-${i}`, 30_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("does not steal a generation while its guarded write is in progress", async () => {
    await claim(tasksDir, "a", "old");
    await forgeLock("old", Date.now() - 60_000);
    let ready!: () => void, finish!: () => void;
    const entered = new Promise<void>(r => { ready = r; });
    const proceed = new Promise<void>(r => { finish = r; });
    const update = withOwnership(tasksDir, "a", "old", async () => { ready(); await proceed; });
    await entered;
    let claimed = false;
    const takeover = claim(tasksDir, "a", "new", 30_000).then(value => { claimed = value; });
    await new Promise(r => setTimeout(r, 30));
    expect(claimed).toBe(false);
    finish(); await update; await takeover;
    expect(claimed).toBe(true);
    await expect(withOwnership(tasksDir, "a", "old", async () => { throw new Error("must not write"); })).rejects.toBeInstanceOf(OwnershipLostError);
  });
  it("first claim wins, creating the lock with worker and heartbeat", async () => {
    // 辅助目录 tasks/a/ 尚不存在，claim 需自行创建
    expect(await claim(tasksDir, "a", "worker-1")).toBe(true);
    const lock = await readLock();
    expect(lock.worker).toBe("worker-1");
    expect(lock.heartbeat).toBeGreaterThan(Date.now() - 60_000);
  });

  it("second claim by the same or a different worker returns false", async () => {
    expect(await claim(tasksDir, "a", "worker-1")).toBe(true);
    await expect(claim(tasksDir, "a", "worker-1")).resolves.toBe(false);
    await expect(claim(tasksDir, "a", "worker-2")).resolves.toBe(false);
    // 失败的 claim 不得改动现有锁
    await expect(readLock()).resolves.toMatchObject({ worker: "worker-1" });
  });

  it("takes over an expired lock on a running task and archives the old one", async () => {
    // Review Focus 1：任务已 running，持有者心跳过期（已崩溃）→ 接管成功
    await writeFile(join(tasksDir, "a.md"), runningMd, "utf8");
    await forgeLock("crashed", Date.now() - LOCK_TTL_MS_DEFAULT - 5_000);

    expect(await claim(tasksDir, "a", "worker-2")).toBe(true);

    const lock = await readLock();
    expect(lock.worker).toBe("worker-2");
    expect(lock.heartbeat).toBeGreaterThan(Date.now() - 60_000);

    // 旧锁被改名归档为 lock.json.stale-<ts>，内容保留原持有者
    const aux = await readdir(join(tasksDir, "a"));
    const archived = aux.find((f) => /^lock\.json\.stale-\d+$/.test(f));
    expect(archived).toBeDefined();
    const old = JSON.parse(await readFile(join(tasksDir, "a", archived!), "utf8"));
    expect(old).toMatchObject({ worker: "crashed" });
  });

  it("treats a corrupt lock as stale: isStale true, takeover succeeds", async () => {
    // 锁内容损坏（如写入中途崩溃）→ 无法证明存活 → 允许接管，自愈而非卡死
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeFile(lockPath(), "{{{ not json", "utf8");
    await expect(isStale(lockPath(), 60_000)).resolves.toBe(true);

    expect(await claim(tasksDir, "a", "worker-2")).toBe(true);
    const lock = await readLock();
    expect(lock.worker).toBe("worker-2");
    expect(lock.heartbeat).toBeGreaterThan(Date.now() - 60_000);
  });

  it("honours a configured ttl: 过期判定跟随 ttlMs 参数而非固定默认值", async () => {
    // 同一把 5 秒前心跳的锁：ttl 60s 视为存活，ttl 1s 视为过期可接管
    await forgeLock("crashed", Date.now() - 5_000);

    await expect(claim(tasksDir, "a", "worker-2", 60_000)).resolves.toBe(false);

    await forgeLock("crashed", Date.now() - 5_000);
    await expect(claim(tasksDir, "a", "worker-2", 1_000)).resolves.toBe(true);
    await expect(readLock()).resolves.toMatchObject({ worker: "worker-2" });
  });
});

describe("heartbeat", () => {
  it("refreshes an expired heartbeat back to fresh, keeping the worker", async () => {
    await claim(tasksDir, "a", "worker-1");
    await forgeLock("worker-1", Date.now() - 120_000);

    await expect(heartbeat(tasksDir, "a", "worker-1")).resolves.toBe(true);
    await expect(isStale(lockPath(), 60_000)).resolves.toBe(false);
    await expect(readLock()).resolves.toMatchObject({ worker: "worker-1" });
  });

  it("does not clobber a lock owned by another worker — returns false", async () => {
    await forgeLock("worker-2", Date.now() - 120_000);
    await expect(heartbeat(tasksDir, "a", "worker-1")).resolves.toBe(false);
    await expect(readLock()).resolves.toMatchObject({ worker: "worker-2" });
  });

  it("is a no-op (false) when no lock exists", async () => {
    await expect(heartbeat(tasksDir, "a", "worker-1")).resolves.toBe(false);
    await expect(readdir(join(tasksDir, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns false on a torn (corrupt) lock — must not resurrect over it", async () => {
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeFile(lockPath(), "{{{ torn", "utf8");
    await expect(heartbeat(tasksDir, "a", "worker-1")).resolves.toBe(false);
  });
});

describe("lockLive", () => {
  it("true while the heartbeat is fresh, false once stale", async () => {
    await forgeLock("worker-1", Date.now());
    await expect(lockLive(tasksDir, "a", 60_000)).resolves.toBe(true);

    await forgeLock("worker-1", Date.now() - 60_001);
    await expect(lockLive(tasksDir, "a", 60_000)).resolves.toBe(false);
  });

  it("false for a missing lock and for a corrupt one (nothing provably alive)", async () => {
    await expect(lockLive(tasksDir, "a", 60_000)).resolves.toBe(false);
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeFile(lockPath(), "{{{ not json", "utf8");
    await expect(lockLive(tasksDir, "a", 60_000)).resolves.toBe(false);
  });
});

describe("isStale", () => {
  it("false while the heartbeat is fresh, true once it ages past the ttl", async () => {
    await claim(tasksDir, "a", "worker-1");
    await heartbeat(tasksDir, "a", "worker-1");
    await expect(isStale(lockPath(), 60_000)).resolves.toBe(false);

    await forgeLock("worker-1", Date.now() - 60_001);
    await expect(isStale(lockPath(), 60_000)).resolves.toBe(true);
  });

  it("returns false when the lock file does not exist", async () => {
    await expect(isStale(join(tasksDir, "a", "lock.json"), 1_000)).resolves.toBe(false);
  });

  it("exposes the documented default ttl of ten minutes", () => {
    expect(LOCK_TTL_MS_DEFAULT).toBe(10 * 60_000);
  });
});

describe("release", () => {
  it("frees the lock so another worker can claim", async () => {
    expect(await claim(tasksDir, "a", "worker-1")).toBe(true);
    await expect(claim(tasksDir, "a", "worker-2")).resolves.toBe(false);

    await expect(release(tasksDir, "a")).resolves.toBeUndefined();
    expect(await claim(tasksDir, "a", "worker-2")).toBe(true);
    await expect(readLock()).resolves.toMatchObject({ worker: "worker-2" });
  });

  it("removing an absent lock is a no-op", async () => {
    await expect(release(tasksDir, "a")).resolves.toBeUndefined();
  });

  it("with an expected worker, a foreign lock survives and our own is removed", async () => {
    await forgeLock("worker-new", Date.now());

    await release(tasksDir, "a", "worker-old");
    await expect(readLock()).resolves.toMatchObject({ worker: "worker-new" });

    await release(tasksDir, "a", "worker-new");
    await expect(readdir(join(tasksDir, "a"))).resolves.toEqual([]);
  });

  it("without an expected worker it deletes whatever lock is there (v0.1 behavior)", async () => {
    await forgeLock("whoever", Date.now());
    await release(tasksDir, "a");
    await expect(readdir(join(tasksDir, "a"))).resolves.toEqual([]);
  });
});
