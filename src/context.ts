import type { Task } from "./task-file.js";
import { pickFeedback, readFeedback, renderEntry, type FeedbackRecord } from "./feedback.js";
import { SPEC_NOTE } from "./protocol.js";
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

/** What stands where the middle of a too-long spec was left out. */
const SPEC_CUT_MARKER = "\n\n…（规格过长，中段已省略）…\n\n";

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
function clippedSpec(specMarkdown: string): string {
  return clipHeadTail(specMarkdown.trim(), SPEC_MAX_CHARS, SPEC_CUT_MARKER);
}

/**
 * The spec section as one text: the spec, clipped to {@link SPEC_MAX_CHARS} when
 * it is longer, ending with the fixed note from {@link SPEC_NOTE}.
 */
export function specSection(specMarkdown: string): string {
  return `${clippedSpec(specMarkdown)}\n\n${SPEC_NOTE}`;
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
