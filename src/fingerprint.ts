import { createHash } from "node:crypto";

/**
 * Failure fingerprints for acceptance output.
 *
 * Two acceptances of the same unchanged bug print the same evidence — except for
 * the parts that are about *when* it ran: a clock stamp in the log header, the
 * absolute path the harness was invoked with, "took 18432 ms". Hashing the raw
 * output makes every run unique and the circuit breaker never fires; hashing the
 * normalized output answers the only question that matters: "is this the same
 * failure again?"
 *
 * The normalization is deliberately lossy in one direction only. It removes time,
 * location and measurement, and leaves every token of the failure itself: the
 * assertion text, the file/line of a stack frame's tail, the numbers that were
 * expected and observed.
 */
export type NormalizeOptions = {
  /**
   * Absolute roots to strip first (the task workdir and tasks dir). They are
   * removed before the generic path rules so both halves of a path comparison
   * survive: `<workdir>\out\bio.tif` and `D:\other-checkout\out\bio.tif` are the
   * same artifact, and the tail `out\bio.tif` is what the failure is about.
   */
  roots?: string[];
};

/** ISO-8601 date, with or without a time and a zone. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

/** A bare clock time — `[12:03:44]`, `at 09:15`, `09:15:22.512`. */
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\b/g;

/** `1234 ms`, `1.5s`, `3 seconds`, `耗时 12.7 秒`, `1 min`. */
const DURATION = /\b\d+(?:[.,]\d+)?\s*(?:ms|msec|milliseconds?|毫秒|secs?|seconds?|秒|mins?|minutes?|分钟)\b/gi;

/** Windows drive path: `D:\a\b`, `C:/a/b`. */
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|]*/g;

/** UNC path: `\\host\share\...`. */
const UNC_PATH = /\\\\[^\s"'<>|]+/g;

/** POSIX absolute path: `/home/x/y`, `/mnt/c/out/bio.tif`. */
const POSIX_PATH = /(?:\/[\w.\-+@]+){1,}\/?/g;

/**
 * What is left of a path once its root was replaced: `<root>\out\bio.tif`. The
 * root is the machine-specific half and is gone; the tail is the same artifact
 * on every checkout and must normalize the same way an absolute path does.
 */
const ROOT_TAIL_PATH = /(?:[\\/][\w.\-+@]+){1,}[\\/]?/g;

/** UUIDs, long hex blobs (commit-ish), and standalone 4+ digit numbers. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
const LONG_NUMBER = /\b\d{4,}\b/g;

/** Bounds of the fingerprinted text; the middle of a 10k-line dump says little. */
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 2_000;

/**
 * Rewrite machine-varying noise to stable placeholders and return one comparison
 * string. Line structure is kept (a failure's first lines are its identity), the
 * line endings are not.
 */
export function normalizeFailureOutput(text: string, options: NormalizeOptions = {}): string {
  let out = text.replace(/\r\n?/g, "\n");
  for (const root of options.roots ?? []) {
    const trimmed = root.replace(/[\\/]+$/, "");
    if (trimmed.length === 0) continue;
    out = out.replace(new RegExp(escapeRegExp(trimmed), "gi"), "<root>");
  }
  out = out
    .replace(WINDOWS_PATH, "<path>")
    .replace(UNC_PATH, "<path>")
    .replace(POSIX_PATH, "<path>")
    .replace(ROOT_TAIL_PATH, "<path>")
    .replace(ISO_DATE, "<time>")
    .replace(CLOCK_TIME, "<time>")
    .replace(DURATION, "<duration>")
    .replace(UUID, "<uuid>")
    .replace(LONG_HEX, "<hex>")
    .replace(LONG_NUMBER, "<n>");

  const lines = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0);
  const joined = lines.join("\n");
  const bounded = joined.length <= HEAD_CHARS + TAIL_CHARS
    ? joined
    : `${joined.slice(0, HEAD_CHARS)}\n…\n${joined.slice(-TAIL_CHARS)}`;
  return bounded;
}

/** A short, stable hash of the normalized failure — the failure's identity. */
export function failureFingerprint(text: string, options: NormalizeOptions = {}): string {
  return createHash("sha256").update(normalizeFailureOutput(text, options)).digest("hex").slice(0, 16);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
