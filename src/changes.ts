import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** At most this many `git status --porcelain` lines reach the reviewer. */
export const MAX_STATUS_LINES = 200;
/** At most this many `git diff --stat` lines reach the reviewer. */
export const MAX_DIFF_STAT_LINES = 200;

/**
 * What changed in a workspace, as text the reviewer can read: the
 * `git status --porcelain` change list and the `git diff --stat` summary of
 * the working tree against `HEAD`. Both are line-capped; a cap hit is visible
 * in the text itself (a `… 截断` marker naming the true count), never silent.
 *
 * Collection never throws and never blocks a review: a non-Git workdir (or a
 * missing `git`) yields explicit "不可用" notes, because most of the story is
 * still in the other evidence and an unavailable change list is a fact, not a
 * verdict. `HEAD`-less repositories (fresh `git init`, nothing committed yet)
 * fall back to `git diff --stat`, which diffs against the index.
 */
export type ChangeEvidence = {
  /** `git status --porcelain` lines, capped at {@link MAX_STATUS_LINES}. */
  status: string;
  /** `git diff [--stat]` summary, capped at {@link MAX_DIFF_STAT_LINES}. */
  diffStat: string;
};

/** Show at most `limit` lines; when more exist, say so instead of hiding it. */
function capLines(text: string, limit: number, label: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= limit) return lines.join("\n");
  return [...lines.slice(0, limit), `… 截断：${label} 共 ${lines.length} 行，仅注入前 ${limit} 行`].join("\n");
}

/** Run git quietly; every failure becomes an explicit unavailable note. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "-c", "core.quotepath=false", ...args], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch {
    return null;
  }
}

/** The workspace change list and diffstat for the review evidence (C3). */
export async function collectChangeEvidence(cwd: string): Promise<ChangeEvidence> {
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status === null) {
    return {
      status: "(不可用：git status 无法运行——不是 git 工作目录，或 git 不在 PATH 上)",
      diffStat: "(不可用：同上，无法收集改动统计)",
    };
  }
  // `git diff HEAD` fails on an unborn branch (nothing committed yet); the
  // index-only diff is the honest fallback there. An empty result is stated
  // as such — the caller must be able to tell "collected, nothing changed"
  // from "never collected".
  const diffStat = (await git(cwd, ["diff", "HEAD", "--stat"])) ?? (await git(cwd, ["diff", "--stat"]));
  return {
    status: capLines(status, MAX_STATUS_LINES, "git status"),
    diffStat: diffStat === null
      ? "(不可用：git diff --stat 无法运行)"
      : capLines(diffStat, MAX_DIFF_STAT_LINES, "git diff --stat") || "(空)",
  };
}
