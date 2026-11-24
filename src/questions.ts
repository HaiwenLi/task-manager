import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What raised the questions: the clarify session judged the information
 * insufficient, or a human rejected the finished work because the
 * specification itself was wrong.
 */
export type QuestionOrigin = "intake" | "rejection";

/** The open questions of one task, as `questions.md` records them. */
export type OpenQuestions = { origin: QuestionOrigin; items: string[] };

const ORIGIN_LINE: Record<QuestionOrigin, string> = {
  intake: "澄清会话判定信息不足（needs-information）",
  rejection: "人工打回，问题出在澄清/spec，而不是执行（stage=clarify）",
};

/** `tasks/<id>/questions.md` — present exactly while a draft may not be approved. */
export function questionsPath(tasksDir: string, id: string): string {
  return join(tasksDir, id, "questions.md");
}

/**
 * Write the questions a human must answer before the draft is approved, and
 * return the path. The file says how to answer, so `add` only has to print
 * where it is.
 */
export async function writeQuestions(tasksDir: string, id: string, items: string[], origin: QuestionOrigin): Promise<string> {
  const path = questionsPath(tasksDir, id);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, [
    "# 待回答的问题", "",
    `来源：${ORIGIN_LINE[origin]}`, "",
    "## 待回答", "",
    ...items.map((item, index) => `${index + 1}. ${item}`), "",
    "## 怎么回答", "",
    "把答案写进一个文件（按顺序分段即可），然后执行：", "",
    `    taskctl answer --task ${id} --file <答案文件> [--tasks-dir <dir>]`, "",
    "答案会原文追加到 spec.md 和任务正文（执行者读的是任务正文），之后才能 `taskctl approve`。",
    "也可以直接修订 spec.md 后删除本文件——那是你的决定，但不会再有提醒。",
    "",
  ].join("\n"), "utf8");
  return path;
}

/**
 * The open questions of a task, or `null` when it has none. Only the numbered
 * lines under `## 待回答` count: the rest of the file is instructions.
 */
export async function readQuestions(tasksDir: string, id: string): Promise<OpenQuestions | null> {
  let raw: string;
  try {
    raw = await readFile(questionsPath(tasksDir, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  const start = lines.indexOf("## 待回答");
  const origin = lines.some((line) => line.startsWith(`来源：${ORIGIN_LINE.rejection}`)) ? "rejection" : "intake";
  const items: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = /^\d+\.\s+(.+)$/.exec(line.trim());
    if (match) items.push(match[1]!.trim());
  }
  return { origin, items };
}

/** Remove the questions; a task without any is left as it is. */
export async function clearQuestions(tasksDir: string, id: string): Promise<void> {
  await rm(questionsPath(tasksDir, id), { force: true });
}
