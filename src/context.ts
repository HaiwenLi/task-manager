import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Task } from "./task-file.js";
import { pickFeedback, readFeedback, renderEntry, type FeedbackRecord } from "./feedback.js";
import { readProfile } from "./profile.js";
import { readSpec } from "./spec.js";

/** Longest spec a worker is given, in code units, the fixed note that closes it not counted. */
export const SPEC_MAX_CHARS = 8_000;
/** Longest profile a worker is given, in code units; the line that says it was cut is not counted. */
export const PROFILE_MAX_CHARS = 2_000;
/** Most corrections a worker is given. */
export const WORKER_FEEDBACK_LIMIT = 5;
/** Longest correction block a worker is given, in code points as rendered. */
export const WORKER_FEEDBACK_MAX_CHARS = 1_500;
/** Longest fixed source a worker is given, in code units; a longer one is clipped head and tail behind a visible marker. */
export const FIXED_SOURCE_MAX_CHARS = 8_000;

/** What stands where the middle of a too-long spec was left out. */
const SPEC_CUT_MARKER = "\n\n…（规格过长，中段已省略）…\n\n";
/** What stands where the middle of a too-long fixed source was left out. */
const SOURCE_CUT_MARKER = "\n\n…（这个文件过长，中段已省略）…\n\n";

/**
 * Keep the head and the tail of a text too long to show whole, with a visible
 * marker where the middle was left out. The head keeps 70% of the room and the
 * tail 30%, and the result is exactly `max` long. A text within the limit is
 * returned as it is.
 */
export function clipHeadTail(text: string, max: number, marker: string): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - marker.length);
  const head = Math.floor(room * 0.7);
  const tail = room - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/**
 * The spec clipped to {@link SPEC_MAX_CHARS}, without the fixed note:
 * `buildWorkerPrompt` (`./protocol.ts`) writes that itself right after, so
 * the prompt carries it once.
 */
export function clippedSpec(specMarkdown: string): string {
  return clipHeadTail(specMarkdown.trim(), SPEC_MAX_CHARS, SPEC_CUT_MARKER);
}

/**
 * The profile a worker is given, and how many characters of it were left out.
 *
 * The profile is append-only, so its newest rules are at its end. Past
 * {@link PROFILE_MAX_CHARS} the last of it is kept, moved forward to the next
 * line break so that no rule is cut in half, behind a line that says this is
 * an excerpt. Within the limit the text is returned as it is.
 */
export function profileSection(profileMarkdown: string): { text: string; truncatedChars: number } {
  if (profileMarkdown.length <= PROFILE_MAX_CHARS) return { text: profileMarkdown, truncatedChars: 0 };
  const cut = profileMarkdown.length - PROFILE_MAX_CHARS;
  const lineBreak = profileMarkdown.indexOf("\n", cut);
  // A line break that ends the file would leave nothing to keep: then the last
  // rule is longer than the whole limit, and its tail is the newest there is.
  const start = lineBreak === -1 || lineBreak + 1 === profileMarkdown.length ? cut : lineBreak + 1;
  const notice = `（档案共 ${profileMarkdown.length} 字符，这里只保留最新的部分）\n`;
  return { text: notice + profileMarkdown.slice(start), truncatedChars: start };
}

/**
 * The corrections a worker can act on: what a human sent back from the worker
 * stage, and the note a human left when letting work through. A reviewer's
 * misjudgement is about the verdict, and a wrong spec has its answer in the
 * spec by now; neither tells the worker how to work.
 */
export function isWorkerRelevant(record: FeedbackRecord): boolean {
  return record.stage === "worker" || (record.stage === "none" && record.action === "accept");
}

/**
 * Which sections to read. `preferences` covers both files the owner's
 * preferences live in — the profile and the corrections — because a
 * correction is how a preference gets learned.
 */
export type ContextFlags = { spec: boolean; preferences: boolean };

/** The section texts {@link readContextSections} found; an absent section is an absent key. */
export type ContextSections = {
  /** The approved spec, clipped; the fixed note is the prompt's to add. */
  spec?: string;
  /** The profile, or its newest part behind a line that says so. */
  profile?: string;
  /** One line per chosen correction, without a heading. */
  feedback?: string;
  /** How much of the profile was left out; 0 when all of it was kept. */
  profileTruncatedChars: number;
};

/**
 * Read the three context files of a task: `tasks/<id>/spec.md`, the profile
 * and the corrections, each only while its switch is on. A file that is
 * missing, or empty, leaves its key absent.
 *
 * Throws when a file cannot be read (as opposed to not existing): whether
 * that stops the work is the caller's decision, not this function's.
 */
export async function readContextSections(tasksDir: string, task: Task, flags: ContextFlags): Promise<ContextSections> {
  const sections: ContextSections = { profileTruncatedChars: 0 };
  if (flags.spec) {
    const spec = await readSpec(tasksDir, task.id);
    if (spec !== null && spec.trim().length > 0) sections.spec = clippedSpec(spec);
  }
  if (flags.preferences) {
    const profile = await readProfile(tasksDir);
    if (profile !== null && profile.trim().length > 0) {
      const { text, truncatedChars } = profileSection(profile);
      sections.profile = text;
      sections.profileTruncatedChars = truncatedChars;
    }
    // The corrections are scored against the task's own words, the same way a
    // clarify session's are; only the keep rule and the limits are the worker's.
    const chosen = pickFeedback(
      await readFeedback(tasksDir), `${task.title}\n${task.description}`,
      isWorkerRelevant, WORKER_FEEDBACK_LIMIT, WORKER_FEEDBACK_MAX_CHARS,
    );
    if (chosen.length > 0) sections.feedback = chosen.map((record) => oneLine(renderEntry(record))).join("\n");
  }
  return sections;
}

/**
 * One rendered note on one line. `renderEntry` already flattens the note; a
 * line break can still come in through a quoted task title, and a second line
 * in the prompt would read as a rule of its own.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ");
}

/** How one configured source fared: read whole, clipped, empty once trimmed, not there, or there and not readable. */
export type FixedSourceState = "read" | "clipped" | "empty" | "missing" | "unreadable";
/** How one configured source was read. `name` is the file's base name: a path is never shown, journaled or printed. */
export type FixedSourceFile = { name: string; state: FixedSourceState; chars: number; detail?: string };

/**
 * The fixed sources of a configuration, read file by file, in the order they
 * are named: the rules the owner keeps across projects — how text is to be
 * written, what must never happen. They are read, never searched for, so no
 * similarity decides whether a rule reaches the worker: a file that is there
 * is always given, whole up to {@link FIXED_SOURCE_MAX_CHARS}.
 *
 * A file that cannot be given is reported, never thrown, and the next one is
 * read. It is `missing` when there is no such file to read, a directory on
 * the way to it that is not there included; `unreadable`, with the error's
 * code, when the read failed any other way. Only that code is kept: the
 * message of a failed read names the path.
 *
 * `text` is what the prompt carries: each file behind a line with its base
 * name, a file too long behind a line saying how long it is whole. It is
 * `undefined` when no file could be read at all.
 */
export async function readFixedSources(paths: readonly string[]): Promise<{ text: string | undefined; files: FixedSourceFile[] }> {
  const files: FixedSourceFile[] = [];
  const blocks: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      files.push(error.code === "ENOENT" || error.code === "ENOTDIR"
        ? { name, state: "missing", chars: 0 }
        : { name, state: "unreadable", chars: 0, detail: error.code ?? error.name });
      continue;
    }
    // As the file holds it, minus a byte-order mark, `\r\n` and the blank ends.
    const text = (raw.startsWith("\uFEFF") ? raw.slice(1) : raw).replace(/\r\n/g, "\n").trim();
    if (text.length === 0) {
      files.push({ name, state: "empty", chars: 0 });
      continue;
    }
    const clipped = text.length > FIXED_SOURCE_MAX_CHARS;
    const content = clipped ? clipHeadTail(text, FIXED_SOURCE_MAX_CHARS, SOURCE_CUT_MARKER) : text;
    files.push({ name, state: clipped ? "clipped" : "read", chars: content.length });
    // A clipped file says how long it is whole, so nobody takes the excerpt for the file.
    const notice = clipped ? `（文件共 ${text.length} 字符，这里只保留开头和结尾）\n` : "";
    blocks.push(`【${name}】\n${notice}${content}`);
  }
  return { text: blocks.length === 0 ? undefined : blocks.join("\n\n"), files };
}

/**
 * The fixed sources on one journal line: one item per file in the order
 * configured, each the file's name and what came of reading it — how many
 * characters were given, or that it was clipped, empty, missing, or could not
 * be read and with what error.
 */
export function sourcesDetail(files: readonly FixedSourceFile[]): string {
  return files.map((file) => {
    switch (file.state) {
      case "read": return `${file.name}=${file.chars}`;
      case "clipped": return `${file.name}=clipped(${file.chars})`;
      case "empty": return `${file.name}=empty`;
      case "missing": return `${file.name}=missing`;
      case "unreadable": return `${file.name}=unreadable(${file.detail})`;
    }
  }).join("; ");
}
