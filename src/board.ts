import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskStatus } from "./task-file.js";

export type BoardOptions = {
  /** Include the finished group. */
  all: boolean;
  /** One line per task saying where it is stuck. */
  notes: Map<string, string>;
  /** Tasks whose audit passed: the chain did its job. */
  highlighted: Set<string>;
  now: Date;
};

const GROUPS: Array<{ title: string; matches: (status: TaskStatus) => boolean }> = [
  { title: "待我确认", matches: (status) => status === "draft" },
  { title: "待我放行", matches: (status) => status === "awaiting-human" },
  { title: "进行中", matches: (status) => status === "open" || status === "running" || status === "review" },
  { title: "卡住", matches: (status) => status === "blocked" },
];

/**
 * The board is a generated Markdown file, not a state store: it is rewritten on
 * every change and a browser or editor can watch it. Anything read back out of
 * it would be a second source of truth, so nothing does.
 */
export function renderBoardMarkdown(tasks: Task[], options: BoardOptions): string {
  const lines = [
    `# taskctl · ${stamp(options.now)}`,
    "",
    "> 生成物，手改会被下一次重写覆盖。来源：tasks/*.md",
    "",
  ];
  for (const group of GROUPS) {
    const members = tasks.filter((task) => group.matches(task.status));
    if (members.length === 0) continue;
    lines.push(`## ${group.title} ${members.length}`);
    for (const task of members) lines.push(item(task, options, true));
    lines.push("");
  }
  if (options.all) {
    const finished = tasks.filter((task) => task.status === "done");
    if (finished.length > 0) {
      lines.push(`## 已完成 ${finished.length}`);
      for (const task of finished) lines.push(item(task, options, true));
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The same content as the file, without Markdown syntax, for a terminal. */
export function renderBoardTable(tasks: Task[], options: BoardOptions): string[] {
  const lines: string[] = [];
  for (const group of GROUPS) {
    const members = tasks.filter((task) => group.matches(task.status));
    if (members.length === 0) continue;
    lines.push(`${group.title} ${members.length}`);
    for (const task of members) lines.push(`  ${item(task, options, false)}`);
  }
  if (options.all) {
    const finished = tasks.filter((task) => task.status === "done");
    if (finished.length > 0) {
      lines.push(`已完成 ${finished.length}`);
      for (const task of finished) lines.push(`  ${item(task, options, false)}`);
    }
  }
  return lines;
}

/** `tasks/../.taskctl/board.md` — deliberately outside `tasks/`, which holds task files. */
export function boardPath(tasksDir: string): string {
  return join(tasksDir, "..", ".taskctl", "board.md");
}

/** Rewrite the board atomically so a watching browser never sees half a file. */
export async function writeBoard(tasksDir: string, markdown: string): Promise<string> {
  const path = boardPath(tasksDir);
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, markdown, "utf8");
  await rename(tmp, path);
  return path;
}

function item(task: Task, options: BoardOptions, bullet: boolean): string {
  const star = options.highlighted.has(task.id) ? "★ " : "";
  const note = options.notes.get(task.id) ?? task.status;
  return `${bullet ? "- " : ""}${star}${task.id} ${task.title} · ${task.complexity} · ${note}`;
}

/** Local time: the board is read by a person, not by a machine. */
function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
