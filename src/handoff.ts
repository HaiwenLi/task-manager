import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";

/**
 * A numbered handoff note: the working memory a session leaves behind when
 * its Context Budget nears exhaustion (ADR-0003). The note is the next
 * session's injected context and a human-readable progress record. The five
 * body sections mirror OpenCode's compaction summary structure.
 */
export type HandoffNote = {
  /** Filename stem of the task this note belongs to. */
  task: string;
  /** 1-based position in the session chain; the filename is padded to 4 digits. */
  seq: number;
  status: string;
  done: string;
  found: string;
  next: string;
  files: string[];
};

/** The fixed section headings every note body renders, in order. */
const SECTIONS = ["Status", "Done", "Found", "Next", "Files"] as const;

/** Where a note lives: `tasks/<id>/sessions/<seq padded 4>-handoff.md`. */
export function notePath(tasksDir: string, taskId: string, seq: number): string {
  return join(tasksDir, taskId, "sessions", `${String(seq).padStart(4, "0")}-handoff.md`);
}

/**
 * Persist a note and return its path. Frontmatter records `task` and `seq`;
 * the body renders the five fixed sections. The write lands via
 * `<file>.tmp` + rename so an interrupted write can never leave a torn
 * note behind (ADR-0001).
 */
export async function writeNote(tasksDir: string, n: HandoffNote): Promise<string> {
  const path = notePath(tasksDir, n.task, n.seq);
  await mkdir(join(tasksDir, n.task, "sessions"), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, renderNote(n), "utf8");
  await rename(tmp, path);
  return path;
}

/**
 * The highest-numbered note for a task, or null when none was ever written.
 * `seq` comes from the filename — like task ids, the directory listing is
 * authoritative over any frontmatter copy.
 */
export async function latestNote(
  tasksDir: string,
  taskId: string,
): Promise<{ seq: number; markdown: string } | null> {
  let names: string[];
  try {
    names = await readdir(join(tasksDir, taskId, "sessions"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const seqs = names.flatMap((name) => {
    const match = /^(\d+)-handoff\.md$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  if (seqs.length === 0) {
    return null;
  }
  const seq = Math.max(...seqs);
  return { seq, markdown: await readFile(notePath(tasksDir, taskId, seq), "utf8") };
}

/**
 * Render a note to markdown: frontmatter (`task`, `seq`) followed by the
 * five fixed sections. Section content is inserted verbatim — Chinese and
 * multiline text survive a write/read round trip byte for byte.
 */
function renderNote(n: HandoffNote): string {
  const frontmatter = dump({ task: n.task, seq: n.seq }, { lineWidth: -1 });
  const contents: Record<(typeof SECTIONS)[number], string> = {
    Status: n.status,
    Done: n.done,
    Found: n.found,
    Next: n.next,
    Files: n.files.map((file) => `- ${file}`).join("\n"),
  };
  const body = SECTIONS.map((section) => `## ${section}\n${contents[section]}\n`);
  return `---\n${frontmatter}---\n\n${body.join("\n")}`;
}
