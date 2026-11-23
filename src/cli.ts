import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LOCK_TTL_MS_DEFAULT } from "./claim.js";
import { latestNote, writeNote } from "./handoff.js";
import { TaskStore } from "./task-store.js";
import { runWorker, type WorkerConfig } from "./worker.js";
import { runScheduler } from "./scheduler.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type { AgentAdapter } from "./adapters/types.js";
import { serializeTaskFile, type Task, type TaskVerify, TASK_SCHEMA } from "./task-file.js";
import { buildFinding } from "./findings.js";
import { buildClarifyPrompt, detectComplexity, detectType, nextTaskId, TEMPLATES, type TaskType } from "./intake.js";
import { appendObservation, readProfile } from "./profile.js";
import { extractCriteria, readSpec, writeSpec } from "./spec.js";
import { appendJournal } from "./journal.js";
import type { AcceptanceResult } from "./acceptance.js";
import { renderBoardMarkdown, renderBoardTable, writeBoard } from "./board.js";
import { buildReport } from "./report.js";
import { readAudits, summarizeAudits, appendAudit, type AuditStage } from "./audit.js";
import { readRuntime } from "./runtime.js";
import { reconcileTask, retryTask } from "./reconcile.js";
import { checkRender, describeFailures, RenderUnavailableError, DEFAULT_VIEWPORTS } from "./render.js";
import { taskWorkdir } from "./scheduler.js";
import { resolveArtifacts } from "./artifacts.js";

/** Injection seams for tests: adapter (for `add`/`run`), acceptance gate, clock, output. */
export type CliDeps = {
  adapter?: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  now?: () => Date;
  log?: (line: string) => void;
  err?: (line: string) => void;
};

/** Resolved `taskctl.json` — a WorkerConfig plus the adapter's binary name. */
type ResolvedConfig = WorkerConfig & { opencodeBin?: string };

/** Usage problem (unknown command/flag, missing value): exit code 2. */
class UsageError extends Error {}

const USAGE = [
  "usage:",
  "  taskctl add \"<意图>\" [--type code|office|research|design] [--simple] [--quick] [--verify human|mechanical|render] [--target <a.html,b.html>] [--id <id>] [--config taskctl.json]",
  "  taskctl spec --task <id> [--tasks-dir <dir>]",
  "  taskctl approve --task <id> [--tasks-dir <dir>]",
  "  taskctl run [--log <file>] [--config taskctl.json]",
  "  taskctl verify --task <id> [--viewport 1440x900,390x844] [--config taskctl.json]",
  "  taskctl done --task <id> [--tasks-dir <dir>]",
  "  taskctl note --task <id> --status <s> --done <d> --found <f> --next <n> [--files <a,b>] [--tasks-dir <dir>]",
  "  taskctl status [--tasks-dir <dir>]",
  "  taskctl board [--all] [--json] [--tasks-dir <dir>]",
  "  taskctl report --task <id> [--tasks-dir <dir>]",
  "  taskctl accept --task <id> [--tasks-dir <dir>]",
  "  taskctl reject --task <id> --reason \"…\" [--stage clarify|worker|reviewer] [--tasks-dir <dir>]",
  "  taskctl audit --task <id> --verdict pass|fail [--stage …] [--note \"…\"] [--tasks-dir <dir>]",
  "  taskctl metrics [--tasks-dir <dir>]",
  "  taskctl reconcile --task <id> [--tasks-dir <dir>]",
  "  taskctl retry --task <id> [--tasks-dir <dir>]",
  "  taskctl findings --task <id> [--out <file>] [--tasks-dir <dir>]",
  "  taskctl learn --note \"<原话 → 改法>\" [--tasks-dir <dir>]",
  "  taskctl template [--type code|office|research|design]",
].join("\n");

/** Marker file the `done` subcommand writes; mirrors task-store's DONE_MARKER. */
const DONE_MARKER = "done.requested";

/** Default `--tasks-dir` for the agent-facing subcommands (matches the protocol copy). */
const TASKS_DIR_DEFAULT = "tasks";

/** `--tasks-dir`, else `taskctl.json`'s `tasksDir`, else `tasks`. */
async function tasksDirFor(flags: Map<string, string>): Promise<string> {
  const explicit = flags.get("tasks-dir");
  if (explicit !== undefined) {
    return explicit;
  }
  return resolveConfig(await readConfig(flags.get("config") ?? "taskctl.json"), "taskctl.json").tasksDir;
}

/** Resolve the config file for commands that need settings beyond `tasksDir`. */
async function configFor(flags: Map<string, string>): Promise<ResolvedConfig> {
  const path = flags.get("config") ?? "taskctl.json";
  return resolveConfig(await readConfig(path), path);
}

/**
 * Parse argv and run one subcommand. Hand-rolled `--flag value` parsing —
 * no CLI dependency (binding constraint). Values pass through untouched, so
 * newlines, quotes and Chinese land in note files verbatim (Review Focus 5).
 * Returns the process exit code: 0 ok, 1 runtime error, 2 usage error.
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  try {
    return await dispatch(argv, deps, log);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`taskctl: ${e.message}`);
      err(USAGE);
      return 2;
    }
    err(`taskctl: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function dispatch(argv: string[], deps: CliDeps, log: (line: string) => void): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  if (command === undefined) {
    throw new UsageError("missing command");
  }
  if (positionals.length > 0 && command !== "add") {
    throw new UsageError(`unexpected argument "${positionals[0]}"`);
  }
  switch (command) {
    case "add":
      checkFlags(command, flags, ["type", "simple", "quick", "verify", "target", "id", "config", "risk", "workdir", "tasks-dir", "acceptance"], []);
      return addCommand(positionals, flags, deps, log);
    case "spec":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return specCommand(flags, log);
    case "approve":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return approveCommand(flags, log);
    case "run":
      checkFlags(command, flags, ["config", "log"], []);
      return runCommand(flags, deps, log);
    case "verify":
      checkFlags(command, flags, ["task", "viewport", "tasks-dir", "config"], ["task"]);
      return verifyCommand(flags, log);
    case "done":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return doneCommand(flags, deps, log);
    case "note":
      checkFlags(command, flags, ["task", "status", "done", "found", "next", "files", "tasks-dir", "config"], [
        "task",
        "status",
        "done",
        "found",
        "next",
      ]);
      return noteCommand(flags, log);
    case "status":
      checkFlags(command, flags, ["tasks-dir", "config"], []);
      return statusCommand(flags, log);
    case "board":
      checkFlags(command, flags, ["tasks-dir", "config", "all", "json"], []);
      return boardCommand(flags, log);
    case "report":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return reportCommand(flags, log);
    case "accept":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return acceptCommand(flags, log);
    case "reject":
      checkFlags(command, flags, ["task", "reason", "stage", "tasks-dir", "config"], ["task", "reason"]);
      return rejectCommand(flags, log);
    case "audit":
      checkFlags(command, flags, ["task", "verdict", "stage", "note", "tasks-dir", "config"], ["task", "verdict"]);
      return auditCommand(flags, log);
    case "metrics":
      checkFlags(command, flags, ["tasks-dir", "config"], []);
      return metricsCommand(flags, log);
    case "learn":
      checkFlags(command, flags, ["note", "tasks-dir", "config"], ["note"]);
      return learnCommand(flags, log);
    case "reconcile":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return reconcileCommand(flags, log);
    case "retry":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return retryCommand(flags, log);
    case "findings":
      checkFlags(command, flags, ["task", "out", "tasks-dir", "config"], ["task"]);
      return findingsCommand(flags, log);
    case "template":
      checkFlags(command, flags, ["type", "tasks-dir", "config"], []);
      return templateCommand(flags, log);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

/** `taskctl run` — load config, assemble adapter + store, drain the queue. */
async function runCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const configPath = flags.get("config") ?? "taskctl.json";
  const cfg = resolveConfig(await readConfig(configPath), configPath);
  const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
  const store = new TaskStore(cfg.tasksDir);
  // Controller log: with --log every event line is teed to one operator-chosen
  // file; by default each task's lines land in its own task dir under logs/.
  // This replaces the external `Tee-Object` into the workspace root that
  // motivated task 006 — the controller now keeps its own hygiene.
  const runStamp = new Date().toISOString().replaceAll(":", "-");
  const teeTarget = flags.get("log") !== undefined ? resolve(flags.get("log")!) : undefined;
  if (teeTarget !== undefined) {
    await mkdir(dirname(teeTarget), { recursive: true });
    await writeFile(teeTarget, "", { flag: "a" });
  }
  let logJob: Promise<unknown> = Promise.resolve();
  const writeLogLine = (taskId: string, line: string): void => {
    const target = teeTarget ?? join(cfg.tasksDir, taskId, "logs", `run-${runStamp}.log`);
    logJob = logJob.then(async () => {
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, `${new Date().toISOString()}  ${line}\n`, "utf8");
    }).catch(() => {
      // A log write that cannot happen must not take the run down with it.
    });
  };
  // The board is rewritten on every event, so a browser watching board.md sees
  // tasks move while the run is still going. Writes are chained, never racing.
  let boardJob: Promise<unknown> = Promise.resolve();
  const refreshBoard = (): void => {
    boardJob = boardJob.then(() => refreshBoardFile(cfg.tasksDir)).catch(() => {});
  };
  refreshBoard();
  // Plan Task 9：逐事件打印 [task] 状态 单行日志 —— 事件发生即输出，
  // 而不是整队跑完再补一份总结
  await runScheduler(cfg, {
    store,
    adapter,
    ...(deps.acceptance === undefined ? {} : { acceptance: deps.acceptance }),
    onEvent: (evt) => {
      const line = `[${evt.taskId}] ${evt.type}${evt.detail ? ` ${evt.detail}` : ""}`;
      log(line);
      writeLogLine(evt.taskId, line);
      refreshBoard();
    },
  });
  refreshBoard();
  await boardJob;
  await logJob;
  return 0;
}

/**
 * `taskctl verify --task <id>` — run the same render check the worker will run,
 * so an operator can see the page verdict before queueing anything.
 */
async function verifyCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const cfg = await configFor(flags);
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const task = await new TaskStore(tasksDir).get(id);
  if (task.renderTargets.length === 0) {
    throw new UsageError(`task ${id} declares no render targets; pass --target when adding it`);
  }
  const viewports = (flags.get("viewport") ?? (cfg.renderViewports ?? DEFAULT_VIEWPORTS).join(","))
    .split(",")
    .map((viewport) => viewport.trim())
    .filter((viewport) => viewport.length > 0);
  const evidenceDir = join(tasksDir, id, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const workdir = taskWorkdir(cfg.workdir, task);
  let check;
  try {
    check = await checkRender({
      targets: task.renderTargets.map((target) => join(workdir, target)),
      viewports,
      evidenceDir,
      ...(cfg.chromeBin === undefined ? {} : { chromeBin: cfg.chromeBin }),
    });
  } catch (err) {
    if (err instanceof RenderUnavailableError) {
      log(`render-unavailable  ${err.message}`);
      return 1;
    }
    throw err;
  }
  for (const view of check.views) {
    log(`${view.ok ? "ok  " : "fail"}  ${view.target} @ ${view.viewport}  ` +
      `${view.measurements.scrollWidth}/${view.measurements.clientWidth}px  ${view.screenshot}`);
  }
  if (check.ok) {
    log(`render ok  ${check.views.length} view(s)`);
    return 0;
  }
  log("render failed:");
  for (const failure of describeFailures(check)) log(`  - ${failure}`);
  return 1;
}

/** Rewrite the board from disk state; safe to call at any point. */
async function refreshBoardFile(tasksDir: string): Promise<void> {  const tasks = await new TaskStore(tasksDir).list();
  const notes = await boardNotes(tasksDir, tasks);
  const highlighted = new Set(
    (await readAudits(tasksDir)).filter((record) => record.verdict === "pass" && record.highlight === true).map((record) => record.task),
  );
  await writeBoard(tasksDir, renderBoardMarkdown(tasks, { all: false, notes, highlighted, now: new Date() }));
}

/** `taskctl add "<intent>"` — capture the intent, draft the spec, gate the state. */
async function addCommand(
  positionals: string[],
  flags: Map<string, string>,
  deps: CliDeps,
  log: (line: string) => void,
): Promise<number> {
  const intent = positionals.join(" ").trim();
  if (intent.length === 0) {
    throw new UsageError("add requires the intent as an argument");
  }
  const configPath = flags.get("config") ?? "taskctl.json";
  const cfg = resolveConfig(await readConfig(configPath), configPath);
  const tasksDir = flags.get("tasks-dir") ? resolve(flags.get("tasks-dir")!) : cfg.tasksDir;
  await mkdir(tasksDir, { recursive: true });
  const store = new TaskStore(tasksDir);
  const id = flags.get("id") ?? (await nextTaskId(tasksDir, intent));
  const type = parseType(flags.get("type") ?? detectType(intent));
  const acceptance = flags.get("acceptance");
  const quick = flags.has("quick");
  const verify = parseVerify(flags.get("verify") ?? "human");
  const risk: "normal" | "high" = flags.get("risk") === "high" ? "high" : "normal";
  const renderTargets = (flags.get("target") ?? "")
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
  // A quick task is one nobody signs off and nobody reviews: pairing it with high
  // risk would be two opposite promises in the same file.
  if (quick && risk === "high") {
    throw new UsageError("--quick cannot be combined with --risk high");
  }
  if (verify === "mechanical" && acceptance === undefined) {
    throw new UsageError("--verify mechanical needs --acceptance: without a command there is nothing to verify");
  }
  if (verify === "render" && renderTargets.length === 0) {
    throw new UsageError("--verify render needs at least one --target <file>");
  }
  // Quick means "do not wait for a signature", which is what `simple` already
  // encodes; keeping them in one field avoids a task that claims to be complex
  // while sitting in `open`.
  const complexity = quick || flags.has("simple") ? "simple" : detectComplexity(intent);
  const workdir = flags.get("workdir");
  const task: Task = {
    id,
    title: firstLine(intent).slice(0, 80),
    description: intent,
    status: "draft",
    criteria: [],
    complexity,
    risk,
    ...(workdir !== undefined && { workdir }),
    keepAtRoot: [],
    ...(acceptance !== undefined && { acceptance }),
    dependsOn: [],
    humanCheck: false,
    tolerate: [],
    quick,
    verify,
    renderTargets,
    reviewRounds: 0,
    sessions: [],
    retries: 0,
  };
  await writeFile(join(tasksDir, `${id}.md`), serializeTaskFile(task), { encoding: "utf8", flag: "wx" });

  if (quick) {
    // No clarify session and no spec: the intent is the whole definition. This is
    // the only lane cheap enough for a twenty-second task, and the price is that
    // nothing was written down to check the work against — which is why the worker
    // will not let a quick task finish on its own evidence.
    await store.setStatus(id, "open");
    await appendJournal(tasksDir, id, {
      stage: "clarify",
      event: "quick-lane",
      detail: "no spec; the intent is the definition",
    });
    log(`${id}  open  quick${verify === "human" ? "" : ` verify=${verify}`}`);
    return 0;
  }

  const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
  const profile = await readProfile(tasksDir);
  const prompt = buildClarifyPrompt({ task, type, profile });
  const result = await adapter.prompt({
    text: prompt,
    cwd: cfg.workdir,
    model: cfg.model,
    effort: cfg.effort,
    title: task.title,
  });
  if (result.exitCode !== 0) {
    await appendJournal(tasksDir, id, { stage: "clarify", event: "clarify-failed", detail: `exit ${result.exitCode}` });
    log(`${id}  draft  clarify-failed`);
    return 1;
  }
  const specText = stripFence(result.text).trim();
  if (specText.length === 0) {
    await appendJournal(tasksDir, id, { stage: "clarify", event: "clarify-failed", detail: "empty spec" });
    log(`${id}  draft  clarify-failed`);
    return 1;
  }
  await writeSpec(tasksDir, id, specText);
  let criteria: string[];
  try {
    criteria = extractCriteria(specText);
  } catch (err) {
    await appendJournal(tasksDir, id, {
      stage: "clarify",
      event: "spec-invalid",
      detail: err instanceof Error ? err.message : String(err),
    });
    log(`${id}  draft  spec-invalid`);
    return 1;
  }
  await store.updateFields(id, { criteria });
  if (complexity === "simple") {
    await store.setStatus(id, "open");
  }
  await appendJournal(tasksDir, id, {
    stage: "clarify",
    event: "spec-drafted",
    detail: `criteria=${criteria.length}`,
  });
  log(`${id}  ${complexity === "simple" ? "open" : "draft"}  criteria=${criteria.length}`);
  return 0;
}

/** `taskctl spec --task <id>` — print the draft spec a human is signing off. */
async function specCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const spec = await readSpec(tasksDir, flags.get("task")!);
  for (const line of (spec ?? "(no spec)").split(/\r?\n/)) {
    log(line);
  }
  return 0;
}

/** `taskctl approve --task <id>` — the only way a draft becomes runnable. */
async function approveCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "draft") {
    throw new Error(`task ${id} is ${task.status}, expected draft`);
  }
  let criteria = task.criteria;
  if (criteria.length === 0) {
    // The natural fix is "edit spec.md, then approve": import instead of
    // demanding the frontmatter be hand-edited.
    const spec = await readSpec(tasksDir, id);
    if (spec === null) {
      throw new Error(`task ${id} has no criteria and no spec; re-run taskctl add to draft one`);
    }
    criteria = extractCriteria(spec);
    await store.updateFields(id, { criteria });
  }
  await store.setStatus(id, "open");
  await appendJournal(tasksDir, id, { stage: "human", event: "approved", detail: `criteria=${criteria.length}` });
  log(`${id}  open  approved`);
  return 0;
}

/** `taskctl done --task <id>` — write the marker the worker polls for. */
async function doneCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  await mkdir(join(tasksDir, id), { recursive: true });
  const marker = join(tasksDir, id, DONE_MARKER);
  await writeFile(marker, (deps.now ?? (() => new Date))().toISOString(), "utf8");
  log(marker);
  return 0;
}

/** `taskctl note …` — append the next numbered handoff note, print its path. */
async function noteCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const files = (flags.get("files") ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  const latest = await latestNote(tasksDir, flags.get("task")!);
  const path = await writeNote(tasksDir, {
    task: flags.get("task")!,
    seq: (latest?.seq ?? 0) + 1,
    status: flags.get("status")!,
    done: flags.get("done")!,
    found: flags.get("found")!,
    next: flags.get("next")!,
    files,
  });
  log(path);
  return 0;
}

/** `taskctl status` — one table row per task, then the files it refused to register. */
async function statusCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const store = new TaskStore(tasksDir);
  const { tasks, ignored } = await store.scan();
  const rows: string[][] = [["id", "status", "retries", "sessions", "note"]];
  for (const task of tasks) {
    const note = await latestNote(tasksDir, task.id);
    rows.push([
      task.id,
      task.status,
      String(task.retries),
      String(task.sessions.length),
      note === null ? "-" : statusLineFromNote(note.markdown),
    ]);
  }
  for (const line of renderTable(rows)) {
    log(line);
  }
  // Listed once, at the end, and never as an error: an unregistered Markdown
  // file in `tasks/` is not a broken task, it is not a task. Saying so is how a
  // hand-taken snapshot stops being scheduled instead of silently disappearing.
  if (ignored.length > 0) {
    log("");
    log(`ignored (no \`schema: ${TASK_SCHEMA}\` in frontmatter): ${ignored.join(", ")}`);
  }
  return 0;
}

/** Flags that stand alone, with no value token after them. */
const BOOLEAN_FLAGS = new Set(["simple", "quick", "all", "apply", "json"]);

/** `taskctl board` — rewrite `.taskctl/board.md` and print the same content as a table. */
async function boardCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const tasks = await new TaskStore(tasksDir).list();
  const notes = await boardNotes(tasksDir, tasks);
  const highlighted = new Set(
    (await readAudits(tasksDir)).filter((record) => record.verdict === "pass" && record.highlight === true).map((record) => record.task),
  );
  const now = new Date();
  const options = { all: flags.has("all"), notes, highlighted, now };
  if (flags.has("json")) {
    const payload = tasks.map((task) => ({ id: task.id, status: task.status, complexity: task.complexity, note: notes.get(task.id) ?? null, highlighted: highlighted.has(task.id) }));
    for (const line of JSON.stringify(payload, null, 2).split("\n")) log(line);
    return 0;
  }
  const path = await writeBoard(tasksDir, renderBoardMarkdown(tasks, options));
  for (const line of renderBoardTable(tasks, options)) log(line);
  log("");
  log(path);
  return 0;
}

/** Where each task is stuck, from its latest handoff note or its status. */
async function boardNotes(tasksDir: string, tasks: Task[]): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  for (const task of tasks) {
    const note = await latestNote(tasksDir, task.id);
    const fromNote = note === null ? "-" : statusLineFromNote(note.markdown);
    if (fromNote !== "-") {
      notes.set(task.id, fromNote);
      continue;
    }
    const fallback: Record<string, string> = {
      draft: "等签字",
      "awaiting-human": "等放行",
      review: "复核中",
      running: "执行中",
      open: "排队",
      blocked: "已阻塞",
      done: "完成",
    };
    notes.set(task.id, fallback[task.status] ?? task.status);
  }
  return notes;
}

/** `taskctl report --task <id>` — one page of evidence for a human spot check. */
async function reportCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  for (const line of await buildReport(tasksDir, flags.get("task")!)) {
    log(line);
  }
  return 0;
}

/** `taskctl accept --task <id>` — a human signs off a reviewed task. */
async function acceptCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "awaiting-human") {
    throw new Error(`task ${id} is ${task.status}, expected awaiting-human`);
  }
  // The human gate is the last place an excused defect can still be caught, so
  // what the reviewer tolerated is printed here and not only in `report`.
  const review = await readRuntime<{ externalChanges?: string[] }>(tasksDir, id, "review.json");
  const tolerated = review?.externalChanges ?? [];
  if (tolerated.length > 0) {
    log(`${id}  复核容忍了 ${tolerated.length} 处外部变更，放行前请确认这些不是你该补的：`);
    for (const change of tolerated) log(`  ~ ${change}`);
  }
  await store.setStatus(id, "done");
  await appendJournal(tasksDir, id, { stage: "human", event: "accepted" });
  await appendAudit(tasksDir, { task: id, at: new Date().toISOString(), verdict: "pass", stage: "none", highlight: true });
  log(`${id}  done  accepted`);
  return 0;
}

/** `taskctl reject --task <id> --reason …` — a human sends work back and names the failing stage. */
async function rejectCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const reason = flags.get("reason")!;
  const stage = parseStage(flags.get("stage") ?? "reviewer");
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "awaiting-human") {
    throw new Error(`task ${id} is ${task.status}, expected awaiting-human`);
  }
  const seq = ((await latestNote(tasksDir, id))?.seq ?? 0) + 1;
  await writeNote(tasksDir, { task: id, seq, status: "rejected", done: "人工放行未通过", found: reason, next: reason, files: [] });
  await store.setStatus(id, "open");
  await appendJournal(tasksDir, id, { stage: "human", event: "rejected", detail: `stage=${stage} ${reason}` });
  await appendAudit(tasksDir, { task: id, at: new Date().toISOString(), verdict: "fail", stage, note: reason });
  log(`${id}  open  rejected (stage=${stage})`);
  return 0;
}

/** `taskctl audit --task <id> --verdict pass|fail` — a spot check; it never changes task status. */
async function auditCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const verdict = flags.get("verdict");
  if (verdict !== "pass" && verdict !== "fail") {
    throw new UsageError(`--verdict must be pass or fail`);
  }
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "done") {
    throw new Error(`task ${id} is ${task.status}, only done tasks can be audited`);
  }
  const stage = parseStage(flags.get("stage") ?? (verdict === "pass" ? "none" : "reviewer"));
  const note = flags.get("note");
  await appendAudit(tasksDir, {
    task: id,
    at: new Date().toISOString(),
    verdict,
    stage,
    ...(note === undefined ? {} : { note }),
    ...(verdict === "pass" ? { highlight: true } : {}),
  });
  log(`${id}  audit ${verdict}  stage=${stage}`);
  return 0;
}

/** `taskctl metrics` — which stage keeps failing. */
async function metricsCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const tasks = await new TaskStore(tasksDir).list();
  for (const line of summarizeAudits(await readAudits(tasksDir), tasks)) {
    log(line);
  }
  return 0;
}

function parseStage(value: string): AuditStage {
  const allowed: AuditStage[] = ["clarify", "worker", "reviewer", "none"];
  if (!allowed.includes(value as AuditStage)) {
    throw new UsageError(`unknown stage "${value}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as AuditStage;
}

/** `taskctl learn --note …` — record one preference, verbatim, for the next clarify. */
async function learnCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const path = await appendObservation(tasksDir, flags.get("note")!);
  log(path);
  return 0;
}

/**
 * `taskctl findings --task <id>` — draft a finding from what the task left behind.
 *
 * Prints by default and writes only when asked: a command that silently creates
 * files in the repo is a command people run by accident.
 */
async function findingsCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  let task;
  try {
    task = await new TaskStore(tasksDir).get(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log(`task ${id} not found in ${tasksDir}`);
      return 1;
    }
    throw err;
  }
  const draft = await buildFinding(tasksDir, task);
  const out = flags.get("out");
  if (out === undefined) {
    for (const line of draft.markdown.split("\n")) log(line);
    return 0;
  }
  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, draft.markdown, "utf8");
  log(`${target}  signals=${draft.signals}`);
  return 0;
}

/** `taskctl template [--type …]` — show what the agent will ask and infer. */
async function templateCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const type = parseType(flags.get("type") ?? "code");
  const template = TEMPLATES[type];
  const lines = [
    `## ${type}`,
    "",
    "### 必答（只有你知道；缺了就问，不要编）",
    ...template.required.map((item) => `- ${item}`),
    "",
    "### 可推（agent 自己写，你删）",
    ...template.infer.map((item) => `- ${item}`),
    "",
    "### 补问（最多 3 条，只问会改变验收的空白）",
    ...template.ask.map((item) => `- ${item}`),
  ];
  for (const line of lines) log(line);
  return 0;
}

/**
 * `taskctl reconcile --task <id>` — read-only diagnosis of a blocked task.
 * Prints what a retry would have to clear; it never changes state.
 */
async function reconcileCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const cfg = await configFor(flags);
  const findings = await reconcileTask(tasksDir, flags.get("task")!, { baseWorkdir: cfg.workdir });
  log(`${findings.id}  status=${findings.status}  attempt=${findings.attempt?.phase ?? "none"}  lock=${findings.lockLive ? "live" : "free"}  reservations=${findings.reservations.length}`);
  for (const note of findings.notes) log(`  - ${note}`);
  for (const reservation of findings.reservations) log(`  reservation ${reservation.token} -> ${reservation.cwd}`);
  log(`  verdict: ${findings.verdict}`);
  if (findings.verdict === "retry-allowed") log(`  next: taskctl retry --task ${findings.id}`);
  if (findings.verdict === "manual-review") {
    log("  next: confirm the execution is really gone, then reconcile the evidence by hand (ADR-0007)");
  }
  return 0;
}

/** `taskctl retry --task <id>` — reopen a blocked task once nothing is running. */
async function retryCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const cfg = await configFor(flags);
  const outcome = await retryTask(tasksDir, flags.get("task")!, { baseWorkdir: cfg.workdir });
  if (!outcome.ok) {
    log(`retry refused: ${outcome.reason}`);
    return 1;
  }
  log(`reopened; previous attempt archived to ${outcome.archive}`);
  return 0;
}

/** `--flag value` tokens into a map; bare tokens become positionals. */
function parseArgs(argv: string[]): { command?: string; positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, "true");
        continue;
      }
      const value = argv[++i];
      if (value === undefined) {
        throw new UsageError(`option ${token} requires a value`);
      }
      flags.set(name, value);
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals.shift(), positionals, flags };
}

function parseType(value: string): TaskType {
  const allowed: TaskType[] = ["code", "office", "research", "design"];
  if (!allowed.includes(value as TaskType)) {
    throw new UsageError(`unknown task type "${value}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as TaskType;
}

/** `--verify`, validated here so a typo is a usage error and not a silent default. */
function parseVerify(value: string): TaskVerify {
  const allowed: TaskVerify[] = ["human", "mechanical", "render"];
  if (!allowed.includes(value as TaskVerify)) {
    throw new UsageError(`unknown --verify "${value}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as TaskVerify;
}

/** First non-empty line, used as the task title. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "task";
}

/** Models like to wrap a whole answer in one fence; unwrap that single wrapper. */
function stripFence(text: string): string {
  const match = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text.trim());
  return match ? match[1]! : text;
}

/** Reject unknown flags, then require the mandatory ones. */
function checkFlags(command: string, flags: Map<string, string>, allowed: string[], required: string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) {
      throw new UsageError(`unknown option --${key} for command ${command}`);
    }
  }
  for (const key of required) {
    if (!flags.has(key)) {
      throw new UsageError(`missing required option --${key} for command ${command}`);
    }
  }
}

/** Read `taskctl.json`; a missing file means "all defaults". */
async function readConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config ${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config ${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Fields a `taskctl.json` may carry (v0.1). */
export const CONFIG_KEYS = new Set([
  "tasksDir",
  "workdir",
  "agent",
  "model",
  "effort",
  "contextThreshold",
  "retryLimit",
  "lockTtlMs",
  "heartbeatMs",
  "turnTimeoutMs",
  "acceptanceTimeoutMs",
  "maxSessionsPerTask",
  "maxTurnsPerSession",
  "chainCycles",
  "maxReviewRounds",
  "reviewerModel",
  "reviewerEffort",
  "modelFallbacks",
  "reviewerModelFallbacks",
  "artifactIgnore",
  "artifacts",
  "modelChain",
  "failureFingerprintLimit",
  "parallel",
  "opencodeBin",
  "chromeBin",
  "renderViewports",
]);

/** Merge config file over the defaults; every present field is validated. */
export function resolveConfig(raw: Record<string, unknown>, path: string): ResolvedConfig {
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`config ${path}: unknown field "${key}"`);
    }
  }
  const agent = string(raw, "agent", path) ?? "opencode";
  if (agent !== "opencode") {
    throw new Error(`config ${path}: unknown agent "${agent}" (v0.1: opencode)`);
  }
  return {
    tasksDir: resolve(string(raw, "tasksDir", path) ?? TASKS_DIR_DEFAULT),
    workdir: resolve(string(raw, "workdir", path) ?? process.cwd()),
    agent,
    model: string(raw, "model", path),
    effort: string(raw, "effort", path),
    contextThreshold: number(raw, "contextThreshold", path) ?? 0.8,
    retryLimit: integer(raw, "retryLimit", path) ?? 3,
    lockTtlMs: number(raw, "lockTtlMs", path) ?? LOCK_TTL_MS_DEFAULT,
    heartbeatMs: number(raw, "heartbeatMs", path) ?? 60_000,
    turnTimeoutMs: number(raw, "turnTimeoutMs", path),
    acceptanceTimeoutMs: number(raw, "acceptanceTimeoutMs", path),
    maxSessionsPerTask: integer(raw, "maxSessionsPerTask", path),
    maxTurnsPerSession: integer(raw, "maxTurnsPerSession", path),
    chainCycles: nonNegativeInteger(raw, "chainCycles", path),
    maxReviewRounds: integer(raw, "maxReviewRounds", path),
    reviewerModel: string(raw, "reviewerModel", path),
    reviewerEffort: string(raw, "reviewerEffort", path),
    modelFallbacks: stringArray(raw, "modelFallbacks", path),
    reviewerModelFallbacks: stringArray(raw, "reviewerModelFallbacks", path),
    artifactIgnore: stringArray(raw, "artifactIgnore", path),
    artifacts: resolveArtifacts(raw.artifacts, path),
    modelChain: stringArray(raw, "modelChain", path),
    failureFingerprintLimit: integer(raw, "failureFingerprintLimit", path),
    parallel: integer(raw, "parallel", path),
    opencodeBin: string(raw, "opencodeBin", path),
    chromeBin: string(raw, "chromeBin", path),
    renderViewports: stringArray(raw, "renderViewports", path),
  };
}

function string(raw: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`config ${path}: field "${key}" must be a non-empty string`);
  }
  return value;
}

/** A list of non-empty strings, e.g. a fallback chain of `provider/model` names. */
function stringArray(raw: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`config ${path}: field "${key}" must be an array of non-empty strings`);
  }
  return value as string[];
}

function number(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config ${path}: field "${key}" must be a positive finite number`);
  }
  return value;
}

function integer(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = number(raw, key, path);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`config ${path}: field "${key}" must be an integer`);
  }
  return value;
}

/**
 * A count whose zero is a meaningful setting rather than an omission, such as
 * `chainCycles` (0 = a linear chain). `number` insists on a positive value, so
 * zero is read here before that rule applies.
 */
function nonNegativeInteger(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`config ${path}: field "${key}" must be a non-negative integer`);
  }
  return value;
}

/**
 * The `## Status` section's first non-empty line — the "一句话状态" a
 * `taskctl note` leaves behind. Multiline statuses are represented by their
 * first line so every table row stays a single line.
 */
function statusLineFromNote(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.indexOf("## Status");
  if (heading === -1) {
    return "-";
  }
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim().length > 0) {
      return line.trim();
    }
  }
  return "-";
}

/** Pad every column to the widest cell; the last column is trim-ended. */
function renderTable(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd(),
  );
}
