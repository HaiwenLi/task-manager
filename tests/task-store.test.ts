import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";

const aMd = `---
schema: taskctl/v1
id: a
title: 任务A
status: open
sessions: []
retries: 0
---
A 的正文`;

const bMd = `---
schema: taskctl/v1
id: b
title: 任务B
status: done
sessions: []
retries: 0
---
B 的正文`;

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), "taskctl-store-"));
  await writeFile(join(tasksDir, "a.md"), aMd, "utf8");
  await writeFile(join(tasksDir, "b.md"), bMd, "utf8");
});

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

describe("TaskStore.list", () => {
  it("lists tasks sorted by filename with statuses parsed", async () => {
    const store = new TaskStore(tasksDir);
    const tasks = await store.list();
    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(tasks[0].status).toBe("open");
    expect(tasks[1].status).toBe("done");
  });

  it("ignores non-markdown files and aux directories", async () => {
    // 辅助目录 tasks/a/ 与杂项文件不参与 list
    await mkdir(join(tasksDir, "a"));
    await writeFile(join(tasksDir, "a", "done.requested"), new Date().toISOString(), "utf8");
    await writeFile(join(tasksDir, "notes.txt"), "not a task", "utf8");
    const store = new TaskStore(tasksDir);
    expect((await store.list()).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("TaskStore registration gate", () => {
  it("registers only files that declare schema: taskctl/v1, and reports the rest", async () => {
    // A legal task file that never declared the schema: it is a document, not a
    // task. The directory listing used to be the whole admission policy.
    const legacy = "---\nid: snapshot\ntitle: 013 snapshot at relaunch\nstatus: open\nsessions: []\nretries: 0\n---\n正文";
    await writeFile(join(tasksDir, "013-snapshot-at-relaunch.md"), legacy, "utf8");
    const store = new TaskStore(tasksDir);

    const scan = await store.scan();
    expect(scan.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(scan.ignored).toEqual(["013-snapshot-at-relaunch.md"]);
    // Ignored is not deleted: an explicit read still parses it.
    expect((await store.get("013-snapshot-at-relaunch")).title).toContain("snapshot");
    // And nothing rewrote it in passing.
    expect(await readFile(join(tasksDir, "013-snapshot-at-relaunch.md"), "utf8")).toBe(legacy);
  });

  it("refuses a file that declares a different schema", async () => {
    await writeFile(
      join(tasksDir, "future.md"),
      "---\nschema: taskctl/v2\nid: future\ntitle: 未来格式\nstatus: open\nsessions: []\nretries: 0\n---\n",
      "utf8",
    );
    const scan = await new TaskStore(tasksDir).scan();
    expect(scan.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(scan.ignored).toEqual(["future.md"]);
  });

  it("writes the schema on every rewrite, so a registered file stays registered", async () => {
    await new TaskStore(tasksDir).setStatus("a", "running");
    const raw = await readFile(join(tasksDir, "a.md"), "utf8");
    expect(raw).toContain("schema: taskctl/v1");
    expect((await new TaskStore(tasksDir).scan()).tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("TaskStore.get", () => {
  it("reads one task by id", async () => {
    const store = new TaskStore(tasksDir);
    const b = await store.get("b");
    expect(b.id).toBe("b");
    expect(b.title).toBe("任务B");
    expect(b.description).toContain("B 的正文");
  });
});

describe("TaskStore.setStatus", () => {
  it("persists the new status and preserves the body", async () => {
    const store = new TaskStore(tasksDir);
    await store.setStatus("a", "running");
    const after = await store.get("a");
    expect(after.status).toBe("running");
    expect(after.title).toBe("任务A");
    expect(after.description).toContain("A 的正文");
    expect(after.sessions).toEqual([]);
    expect(after.retries).toBe(0);
  });

  it("leaves no .tmp file behind (atomic tmp+rename)", async () => {
    const store = new TaskStore(tasksDir);
    await store.setStatus("a", "blocked");
    const leftovers = (await readdir(tasksDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("TaskStore.appendSession", () => {
  it("appends without overwriting earlier sessions", async () => {
    const store = new TaskStore(tasksDir);
    await store.appendSession("a", "ses-1");
    await store.appendSession("a", "ses-2");
    const after = await store.get("a");
    expect(after.sessions).toEqual(["ses-1", "ses-2"]);
  });
});

describe("TaskStore.incRetries", () => {
  it("increments, persists, and returns the new value", async () => {
    const store = new TaskStore(tasksDir);
    await expect(store.incRetries("a")).resolves.toBe(1);
    await expect(store.incRetries("a")).resolves.toBe(2);
    expect((await store.get("a")).retries).toBe(2);
  });
});

describe("done marker", () => {
  it("absent → false, written → true, cleared → false", async () => {
    const store = new TaskStore(tasksDir);
    // 无 marker（连辅助目录都不存在）
    await expect(store.readDoneMarker("a")).resolves.toBe(false);

    // 模拟 taskctl done 写入 tasks/<id>/done.requested
    await mkdir(join(tasksDir, "a"));
    await writeFile(join(tasksDir, "a", "done.requested"), new Date().toISOString(), "utf8");
    await expect(store.readDoneMarker("a")).resolves.toBe(true);

    await store.clearDoneMarker("a");
    await expect(store.readDoneMarker("a")).resolves.toBe(false);
  });

  it("clearing an absent marker is a no-op", async () => {
    const store = new TaskStore(tasksDir);
    await expect(store.clearDoneMarker("a")).resolves.toBeUndefined();
  });
});

describe("pipeline mutations", () => {
  it("incReviewRounds increments and persists", async () => {
    await writeFile(
      join(tasksDir, "c.md"),
      "---\nschema: taskctl/v1\ntitle: C\nstatus: review\nreview_rounds: 1\nsessions: []\nretries: 0\n---\n",
      "utf8",
    );
    const store = new TaskStore(tasksDir);
    await expect(store.incReviewRounds("c")).resolves.toBe(2);
    expect((await store.get("c")).reviewRounds).toBe(2);
  });

  it("updateFields patches only the listed keys and keeps criteria order", async () => {
    const store = new TaskStore(tasksDir);
    await store.updateFields("a", { status: "draft", criteria: ["C1 甲", "C2 乙"] });
    const task = await store.get("a");
    expect(task.status).toBe("draft");
    expect(task.criteria).toEqual(["C1 甲", "C2 乙"]);
    expect(task.title).toBe("任务A");
    expect(task.sessions).toEqual([]);
  });
});
