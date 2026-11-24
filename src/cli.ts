import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LOCK_TTL_MS_DEFAULT } from "./claim.js";
import { latestNote, writeNote } from "./handoff.js";
import { TaskStore } from "./task-store.js";
import { runTask, runWorker, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "./worker.js";
import { runScheduler } from "./scheduler.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type { AgentAdapter } from "./adapters/types.js";
import { serializeTaskFile, type Task, type TaskExecution, type TaskVerify, TASK_SCHEMA } from "./task-file.js";
import { buildFinding } from "./findings.js";
import { buildClarifyPrompt, detectComplexity, detectType, nextTaskId, parseIntakeAssessment, TEMPLATES, type TaskType } from "./intake.js";
import { appendObservation, readProfile } from "./profile.js";
import { extractCriteria, readSpec, SpecError, writeSpec } from "./spec.js";
import { appendJournal } from "./journal.js";
import type { AcceptanceResult } from "./acceptance.js";
import { createCoalescedRefresh, renderBoardMarkdown, renderBoardTable, writeBoard } from "./board.js";
import { buildReport } from "./report.js";
import { readAudits, summarizeAudits, appendAudit, type AuditStage } from "./audit.js";
import { readRelevantFeedback, recordTaskFeedback, type FeedbackEvent } from "./feedback.js";
import { readFlow } from "./metrics.js";
import { clearQuestions, questionsPath, readQuestions, writeQuestions } from "./questions.js";
import { waitReason } from "./eligibility.js";
import {
  applySplitPlan, buildSplitPrompt, parseSplitPlan, readSplitPlan, renderSplitPlan, splitPlanPath, SplitError, writeSplitPlan,
} from "./split.js";
import { readRuntime, readAttempt, writeRuntime } from "./runtime.js";
import { reconcileTask, retryTask } from "./reconcile.js";
import { checkRender, describeFailures, RenderUnavailableError, DEFAULT_VIEWPORTS } from "./render.js";
import { taskWorkdir } from "./scheduler.js";
import { resolveArtifacts } from "./artifacts.js";
import { runSelfCheck } from "./self-check.js";
import { runBatch } from "./batch.js";
import { stopRequestPath, watchQueue, type WatchOptions } from "./watch.js";

/** Injection seams for tests: adapter (for `add`/`run`), acceptance gate, clock, output. */
export type CliDeps = {
  adapter?: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  /** Test seam for review-only recovery without starting a reviewer agent. */
  review?: WorkerDeps["review"];
  /** Test seam for watch filesystem events and timing; production leaves it absent. */
  watch?: WatchOptions;
  /** Test seam for observing watch scheduling; production leaves it absent. */
  store?: TaskStore;
  now?: () => Date;
  log?: (line: string) => void;
  err?: (line: string) => void;
};

/** Resolved `taskctl.json` — a WorkerConfig plus the adapter's binary name. */
type ResolvedConfig = WorkerConfig & { opencodeBin?: string };

/**
 * Evidence plumbing shared by every long-running controller. `run` and `watch`
 * must produce the same per-task event lines and board lifecycle; only the
 * controller behind the deps differs.
 */
type ControllerTelemetry = {
  refreshBoard: () => void;
  writeLogLine: (taskId: string, line: string) => void;
  /** Settle the trailing board refresh and queued log writes. */
  flush: () => Promise<void>;
};

function workerEventLine(evt: WorkerEvent): string {
  return `[${evt.taskId}] ${evt.type}${evt.detail ? ` ${evt.detail}` : ""}`;
}

async function createControllerTelemetry(cfg: ResolvedConfig, teeTarget?: string): Promise<ControllerTelemetry> {
  const runStamp = new Date().toISOString().replaceAll(":", "-");
  if (teeTarget !== undefined) {
    await mkdir(dirname(teeTarget), { recursive: true });
    await writeFile(teeTarget, "", { flag: "a" });
  }
  const boardRefresh = createCoalescedRefresh(() => refreshBoardFile(cfg.tasksDir));
  let logJob: Promise<unknown> = Promise.resolve();
  return {
    refreshBoard: boardRefresh.request,
    writeLogLine: (taskId, line) => {
      const target = teeTarget ?? join(cfg.tasksDir, taskId, "logs", `run-${runStamp}.log`);
      logJob = logJob.then(async () => {
        await mkdir(dirname(target), { recursive: true });
        await appendFile(target, `${new Date().toISOString()}  ${line}\n`, "utf8");
      }).catch(() => {
        // A log write that cannot happen must not take the controller down.
      });
    },
    flush: async () => {
      boardRefresh.request();
      await boardRefresh.flush();
      await logJob;
    },
  };
}

function createWorkerDeps({
  deps, adapter, store, telemetry, log, review = false,
}: {
  deps: CliDeps; adapter: AgentAdapter; store: TaskStore;
  telemetry: ControllerTelemetry; log: (line: string) => void; review?: boolean;
}): WorkerDeps {
  return {
    store,
    adapter,
    ...(deps.acceptance === undefined ? {} : { acceptance: deps.acceptance }),
    ...(review && deps.review !== undefined ? { review: deps.review } : {}),
    onEvent: (evt) => {
      const line = workerEventLine(evt);
      log(line);
      telemetry.writeLogLine(evt.taskId, line);
      telemetry.refreshBoard();
    },
  };
}

/** Usage problem (unknown command/flag, missing value): exit code 2. */
class UsageError extends Error {}

const USAGE = [
  "usage:",
  "  taskctl add \"<意图>\" [--type code|office|research|design] [--simple] [--quick] [--verify human|mechanical|render] [--execution continuous|iterative] [--target <a.html,b.html>] [--id <id>] [--config taskctl.json]",
  "  taskctl spec --task <id> [--tasks-dir <dir>]",
  "  taskctl split --task <id> [--apply] [--tasks-dir <dir>] [--config taskctl.json]",
  "  taskctl approve --task <id> [--tasks-dir <dir>]",
  "  taskctl answer --task <id> --file <path> [--tasks-dir <dir>]",
  "  taskctl run [--batch <id,id,…>] [--log <file>] [--config taskctl.json]",
  "  taskctl watch --config <file> [--resume]",
  "  taskctl stop --tasks-dir <dir>",
  "  taskctl verify --task <id> [--viewport 1440x900,390x844] [--config taskctl.json]",
  "  taskctl done --task <id> [--tasks-dir <dir>]",
  "  taskctl check --task <id> [--tasks-dir <dir>]",
  "  taskctl note --task <id> --status <s> --done <d> --found <f> --next <n> [--files <a,b>] [--tasks-dir <dir>]",
  "  taskctl status [--tasks-dir <dir>]",
  "  taskctl board [--all] [--json] [--tasks-dir <dir>]",
  "  taskctl report --task <id> [--tasks-dir <dir>]",
  "  taskctl accept --task <id> [--note \"…\"] [--tasks-dir <dir>]",
  "  taskctl reject --task <id> --reason \"…\" [--stage clarify|worker|reviewer] [--tasks-dir <dir>]",
  "  taskctl audit --task <id> --verdict pass|fail [--stage …] [--note \"…\"] [--tasks-dir <dir>]",
  "  taskctl metrics [--tasks-dir <dir>]",
  "  taskctl reconcile --task <id> [--tasks-dir <dir>]",
  "  taskctl retry --task <id> [--review-only] [--tasks-dir <dir>]",
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
 * Prior human corrections for this kind of work, for the next clarify session.
 * The history is a learning signal, not state: if it cannot be read, the
 * session runs without it and the operator is told why.
 */
async function relevantFeedback(
  tasksDir: string,
  target: { type: TaskType; intent: string },
  log: (line: string) => void,
): Promise<string | null> {
  try {
    return await readRelevantFeedback(tasksDir, target);
  } catch (error) {
    log(`feedback history unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Keep a human note for later intake. Same tolerance on the way out: losing a
 * note is reported and is never fatal to the decision it describes — by the
 * time this runs, the status change, journal and audit have already landed.
 */
async function recordHumanFeedback(
  tasksDir: string,
  task: Pick<Task, "id" | "title" | "description">,
  log: (line: string) => void,
  event: FeedbackEvent,
): Promise<void> {
  try {
    await recordTaskFeedback(tasksDir, task, event);
  } catch (error) {
    log(`${task.id}  feedback not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
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
      checkFlags(command, flags, ["type", "simple", "quick", "verify", "execution", "target", "id", "config", "risk", "workdir", "tasks-dir", "acceptance"], []);
      return addCommand(positionals, flags, deps, log);
    case "spec":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return specCommand(flags, log);
    case "approve":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return approveCommand(flags, log);
    case "answer":
      checkFlags(command, flags, ["task", "file", "tasks-dir", "config"], ["task", "file"]);
      return answerCommand(flags, log);
    case "split":
      checkFlags(command, flags, ["task", "apply", "tasks-dir", "config"], ["task"]);
      return splitCommand(flags, deps, log);
    case "run":
      checkFlags(command, flags, ["config", "log", "batch"], []);
      return runCommand(flags, deps, log);
    case "watch":
      checkFlags(command, flags, ["config", "resume"], ["config"]);
      return watchCommand(flags, deps, log);
    case "stop":
      checkFlags(command, flags, ["tasks-dir"], ["tasks-dir"]);
      return stopCommand(flags, log);
    case "verify":
      checkFlags(command, flags, ["task", "viewport", "tasks-dir", "config"], ["task"]);
      return verifyCommand(flags, log);
    case "done":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return doneCommand(flags, deps, log);
    case "check":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return checkCommand(flags, log);
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
      checkFlags(command, flags, ["task", "note", "tasks-dir", "config"], ["task"]);
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
      checkFlags(command, flags, ["task", "tasks-dir", "config", "review-only"], ["task"]);
      return retryCommand(flags, deps, log);
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
  const teeTarget = flags.get("log") !== undefined ? resolve(flags.get("log")!) : undefined;
  const telemetry = await createControllerTelemetry(cfg, teeTarget);
  telemetry.refreshBoard();
  const workerDeps = createWorkerDeps({ deps, adapter, store, telemetry, log });
  const batch = flags.get("batch");
  const result = await (async () => {
    try {
      return batch === undefined
        ? await runScheduler(cfg, workerDeps)
        : await runBatch(cfg, workerDeps, batch.split(","));
    } finally {
      // Validation can fail before any event. Still settle the trailing board
      // refresh and queued log writes before the CLI returns or throws.
      await telemetry.flush();
    }
  })();
  if (batch !== undefined && "stoppedAt" in result && result.stoppedAt !== undefined) {
    log(`[batch] stopped at ${result.stoppedAt} (${result.outcome}); unclaimed: ${result.pending.join(", ") || "none"}`);
  } else if (result.pending.length > 0) {
    // Work left in `open` with no explanation reads as "nothing to do". It is not.
    log(
      `[scheduler] stopped at the pass budget with ${result.pending.length} ready task(s) not started: `
      + `${result.pending.join(", ")}. Run taskctl run again to continue.`,
    );
  }
  return 0;
}

/** `taskctl watch` — own and drain one board until its stop request appears. */
async function watchCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const cfg = await configFor(flags);
  const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
  const store = deps.store ?? new TaskStore(cfg.tasksDir);
  const telemetry = await createControllerTelemetry(cfg);
  telemetry.refreshBoard();
  try {
    await watchQueue(cfg, createWorkerDeps({ deps, adapter, store, telemetry, log, review: true }),
      { ...deps.watch, resume: flags.has("resume") });
  } finally {
    await telemetry.flush();
  }
  return 0;
}

/** `taskctl stop` — request a graceful drain; never signals a worker process. */
async function stopCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const path = stopRequestPath(await tasksDirFor(flags));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${new Date().toISOString()}\n`, "utf8");
  log(`stop requested: ${path}`);
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
  const execution = flags.has("execution")
    ? parseExecution(flags.get("execution")!)
    : complexity === "simple" ? "continuous" : "iterative";
  const workdir = flags.get("workdir");
  const task: Task = {
    id,
    title: firstLine(intent).slice(0, 80),
    description: intent,
    status: "draft",
    criteria: [],
    complexity,
    execution,
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
  const feedback = await relevantFeedback(tasksDir, { type, intent }, log);
  const prompt = buildClarifyPrompt({ task, type, profile, ...(feedback === null ? {} : { feedback }) });
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
  const assessment = parseIntakeAssessment(specText, complexity);
  const lane = quick ? "quick" : flags.has("simple") ? "simple" : assessment.lane;
  const selectedComplexity = lane === "complex" ? "complex" : "simple";
  const selectedExecution = flags.has("execution")
    ? execution
    : selectedComplexity === "simple" ? "continuous" : "iterative";
  await store.updateFields(id, { criteria, complexity: selectedComplexity, execution: selectedExecution });
  await writeRuntime(tasksDir, id, "classification.json", {
    lane, proposedLane: assessment.laneEscalated ? null : assessment.lane, laneEscalated: assessment.laneEscalated,
    sufficiency: assessment.sufficiency,
    reason: assessment.reason, model: cfg.model ?? "(backend-default)", type, at: new Date().toISOString(),
  });
  if (assessment.sufficiency === "needs-information") {
    // "Insufficient" with nothing to ask is a model that broke the format, not
    // a reason to wave the draft through: the person is told exactly that.
    const questions = assessment.questions.length > 0
      ? assessment.questions
      : ["澄清会话判定信息不足，但没有列出具体问题：请补充会改变交付物、验收、边界或风险的信息"];
    const path = await writeQuestions(tasksDir, id, questions, "intake");
    await appendJournal(tasksDir, id, {
      stage: "clarify", event: "needs-information", detail: `questions=${questions.length}`,
    });
    log(`${id}  draft  needs-information=${questions.length}  ${path}`);
    return 0;
  }
  if (selectedComplexity === "simple") {
    await store.setStatus(id, "open");
  }
  await appendJournal(tasksDir, id, {
    stage: "clarify",
    event: "spec-drafted",
    detail: `criteria=${criteria.length} lane=${lane} sufficiency=${assessment.sufficiency}`,
  });
  log(`${id}  ${selectedComplexity === "simple" ? "open" : "draft"}  lane=${lane} criteria=${criteria.length}`);
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
  // An open question means the clarify session could not settle the
  // deliverable, the acceptance or the risk boundary. Signing here would turn
  // "nobody knows" into "approved", so the questions are answered first.
  const questions = await readQuestions(tasksDir, id);
  if (questions !== null) {
    throw new Error(
      `task ${id} has ${questions.items.length} unanswered question(s) in ${questionsPath(tasksDir, id)}; `
      + `answer them first: taskctl answer --task ${id} --file <answers>`,
    );
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
  // Signing a split parent is signing the whole bundle: its children, open all
  // along, become runnable at this moment. Saying how many keeps that visible.
  const released = (await store.list()).filter((task) => task.parentId === id && task.status === "open").length;
  log(`${id}  open  approved${released === 0 ? "" : `  bundle: ${released} child task(s) released`}`);
  return 0;
}

/**
 * `taskctl answer --task <id> --file <path>` — the operator answers the open
 * questions, and the only thing that clears them.
 *
 * The answers are appended verbatim to two places. `spec.md` is what the
 * reviewer judges by; the task body is what the worker is briefed on. Writing
 * only the first would leave the worker held to a constraint it never saw.
 * Both are definition text, so the revised task really is a new definition:
 * it has a new digest, and a signature (`approve`) is still required.
 */
async function answerCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const file = flags.get("file")!;
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "draft") {
    throw new Error(`task ${id} is ${task.status}, expected draft`);
  }
  const questions = await readQuestions(tasksDir, id);
  if (questions === null) {
    throw new Error(`task ${id} has no open questions to answer`);
  }
  let answers: string;
  try {
    answers = (await readFile(file, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`answer file not found: ${file}`);
    }
    throw err;
  }
  if (answers.length === 0) {
    throw new Error(`answer file is empty: ${file}`);
  }
  const block = answerBlock(questions.items, answers, new Date().toISOString());
  const spec = await readSpec(tasksDir, id);
  const revisedSpec = `${spec === null ? "" : `${spec.trimEnd()}\n\n`}${block}`;
  // Everything that can fail is decided before anything is written. A task
  // that never had a spec (or whose criteria section was removed by hand)
  // keeps the criteria it already has — the same rule `approve` applies.
  let criteria = task.criteria;
  try {
    criteria = extractCriteria(revisedSpec);
  } catch (err) {
    if (!(err instanceof SpecError)) throw err;
  }
  await writeSpec(tasksDir, id, revisedSpec);
  await store.updateFields(id, {
    description: `${task.description.trimEnd()}\n\n${block}`,
    criteria,
  });
  await clearQuestions(tasksDir, id);
  await appendJournal(tasksDir, id, { stage: "human", event: "answered", detail: `questions=${questions.items.length}` });
  await recordHumanFeedback(tasksDir, task, log, {
    action: "answer",
    verdict: "pass",
    stage: "clarify",
    note: `答：${answers}\n问：${questions.items.join("；")}`,
  });
  log(`${id}  draft  answered=${questions.items.length}  criteria=${criteria.length}`);
  return 0;
}

/** The appended section: the questions as asked, then the answers as written. */
function answerBlock(questions: string[], answers: string, at: string): string {
  return [
    "## 补充回答", "",
    `> ${at.slice(0, 10)} 由人工经 \`taskctl answer\` 追加，与正文具有同等约束力。`, "",
    "### 问题", "",
    ...questions.map((question, index) => `${index + 1}. ${question}`), "",
    "### 回答", "",
    answers, "",
  ].join("\n");
}

/**
 * `taskctl split --task <id> [--apply]` — plan how a draft parent is split,
 * and publish the bundle.
 *
 * Without `--apply` the only thing written is the plan, so it can be read
 * first. With it the bundle is published but held: no child runs until the
 * parent is approved, which is what makes planning and applying in one step
 * safe.
 *
 * A plan that already exists is used as written — shown, or applied. It is
 * never replaced by a fresh model call just because the command ran again,
 * and an edited plan file is applied exactly as edited. To plan again, the
 * plan file is deleted on purpose; the command says so.
 */
async function splitCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const id = flags.get("task")!;
  const apply = flags.has("apply");
  const store = new TaskStore(tasksDir);
  const parent = await store.get(id);
  if (parent.status !== "draft") {
    throw new Error(`task ${id} is ${parent.status}, expected draft: only a parent still waiting for approval can be split`);
  }
  if (parent.parentId !== undefined) {
    throw new Error(`task ${id} is itself a split child; a nested split is not supported`);
  }
  // A plan is made against the spec. With a question still open, that is not
  // yet the spec the work will run by.
  const questions = await readQuestions(tasksDir, id);
  if (questions !== null) {
    throw new Error(
      `task ${id} has ${questions.items.length} unanswered question(s); answer them before planning: `
      + `taskctl answer --task ${id} --file <answers>`,
    );
  }

  let plan = await readSplitPlan(tasksDir, id);
  if (plan === null) {
    const cfg = await configFor(flags);
    const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
    const spec = (await readSpec(tasksDir, id)) ?? "";
    const result = await adapter.prompt({
      text: buildSplitPrompt({ parent, spec }),
      cwd: cfg.workdir,
      model: cfg.model,
      effort: cfg.effort,
      title: `split: ${parent.title}`,
    });
    if (result.exitCode !== 0) {
      await appendJournal(tasksDir, id, { stage: "split", event: "plan-failed", detail: `exit ${result.exitCode}` });
      log(`${id}  draft  split-failed`);
      return 1;
    }
    try {
      plan = parseSplitPlan(result.text, {
        parent, spec, board: await store.list(), model: cfg.model ?? "(backend-default)", now: new Date(),
      });
    } catch (err) {
      if (!(err instanceof SplitError)) throw err;
      await appendJournal(tasksDir, id, { stage: "split", event: "plan-invalid", detail: err.message });
      // The planner's own words are kept: "not a JSON object" is far easier to
      // fix with the text that produced it than with that sentence alone.
      await mkdir(join(tasksDir, id), { recursive: true });
      await writeFile(join(tasksDir, id, "split-plan.rejected.txt"), result.text.slice(0, 20_000), "utf8");
      log(`${id}  draft  split-plan-invalid  ${err.message}`);
      return 1;
    }
    const path = await writeSplitPlan(tasksDir, plan);
    await appendJournal(tasksDir, id, { stage: "split", event: "planned", detail: `children=${plan.children.length}` });
    for (const line of renderSplitPlan(plan)) log(line);
    log(path);
    // Planning alone changes nothing on the board. Publishing is `--apply`.
    if (!apply) return 0;
  } else if (!apply) {
    for (const line of renderSplitPlan(plan)) log(line);
    log(`${splitPlanPath(tasksDir, id)}  (already planned: --apply publishes it as written; delete this file to plan again)`);
    return 0;
  }

  const published = await applySplitPlan(tasksDir, plan);
  await appendJournal(tasksDir, id, {
    stage: "split",
    event: "applied",
    detail: `children=${plan.children.length} written=${published.written.length} present=${published.alreadyPresent.length}`,
  });
  log(`${id}  draft  split applied  children=${plan.children.length}  written=${published.written.length}  already-present=${published.alreadyPresent.length}`);
  log(`held until the parent is approved: review the child files, then taskctl approve --task ${id}`);
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

/** `taskctl check` — run the declared worker-side bounded generation/check. */
async function checkCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const cfg = await configFor(flags);
  const id = flags.get("task")!;
  const task = await new TaskStore(tasksDir).get(id);
  const attempt = await readAttempt(tasksDir, id);
  if (task.status !== "running" || attempt?.phase !== "active") {
    throw new Error(`task ${id} is not running with an active attempt; worker self-check refused`);
  }
  const command = task.workerSelfCheck?.trim();
  if (!command) throw new Error(`task ${id} has no worker_self_check declaration`);
  const timeoutMs = task.workerSelfCheckTimeoutMs ?? 20 * 60_000;
  const turnBound = cfg.turnTimeoutMs ?? 30 * 60_000;
  if (timeoutMs > turnBound) {
    throw new Error(`task ${id}: worker_self_check_timeout_ms ${timeoutMs} exceeds turnTimeoutMs ${turnBound}`);
  }
  const startedAt = new Date().toISOString();
  const result = await runSelfCheck({ command, cwd: taskWorkdir(cfg.workdir, task), timeoutMs });
  await writeRuntime(tasksDir, id, "self-check.json", {
    command, mode: "generate", startedAt, finishedAt: new Date().toISOString(), result,
  });
  const exitCode = "exitCode" in result ? result.exitCode : null;
  log(`${id}  self-check ${result.passed ? "passed" : "failed"}  exit=${exitCode ?? "null"}`);
  return result.passed ? 0 : 1;
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
    rows.push([
      task.id,
      task.status,
      String(task.retries),
      String(task.sessions.length),
      await waitingOn(tasksDir, task, tasks),
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
const BOOLEAN_FLAGS = new Set(["simple", "quick", "all", "apply", "json", "review-only"]);

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

const STUCK_LABELS: Record<string, string> = { blocked: "已阻塞", "awaiting-human": "等放行", draft: "等签字" };

/**
 * What a task is waiting on, in words: the status line of its latest handoff
 * note; else, for an open task, why it is not ready — an unsigned bundle, a
 * dependency, or a dependency that will not finish on its own; else, for a
 * draft, the bundle its signature releases; else its open questions; else `-`.
 *
 * A task sitting in `open` with no explanation reads as "nothing to do". For a
 * held or blocked task that is exactly wrong, and it is what a person looking
 * at the board most needs to know.
 */
async function waitingOn(tasksDir: string, task: Task, board: Task[]): Promise<string> {
  const note = await latestNote(tasksDir, task.id);
  const fromNote = note === null ? "-" : statusLineFromNote(note.markdown);
  if (fromNote !== "-") return fromNote;
  if (task.status === "open") {
    const reason = waitReason(task, board);
    if (reason?.kind === "bundle-approval") return `等父任务批准（${reason.ancestor} 仍是 draft）`;
    if (reason?.kind === "dependencies") {
      if (reason.stuck.length === 0) return `等依赖：${reason.pending.join(", ")}`;
      const statusOf = new Map(board.map((other) => [other.id, other.status]));
      const stuck = reason.stuck.map((id) => {
        const status = statusOf.get(id);
        return `${id}（${status === undefined ? "不存在" : STUCK_LABELS[status] ?? status}）`;
      });
      const others = reason.pending.filter((id) => !reason.stuck.includes(id));
      return `依赖受阻：${stuck.join(", ")}${others.length === 0 ? "" : `；另等：${others.join(", ")}`}`;
    }
  }
  if (task.status === "draft") {
    const children = board.filter((other) => other.parentId === task.id).length;
    if (children > 0) return `等签字（拆分包：${children} 个子任务随之放行）`;
  }
  const questions = await readQuestions(tasksDir, task.id);
  return questions === null ? "-" : `待回答问题 ${questions.items.length} 条（${questionsPath(tasksDir, task.id)}）`;
}

/** Where each task is stuck, from its latest handoff note or its status. */
async function boardNotes(tasksDir: string, tasks: Task[]): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  for (const task of tasks) {
    const waiting = await waitingOn(tasksDir, task, tasks);
    if (waiting !== "-") {
      notes.set(task.id, waiting);
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
  if (flags.has("note")) {
    await recordHumanFeedback(tasksDir, task, log, { action: "accept", verdict: "pass", stage: "none", note: flags.get("note")! });
  }
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
  if (stage === "clarify") {
    // The specification itself is wrong. Reopening the worker would spend a
    // turn executing a definition the human has just rejected, so the task
    // goes back to intake: draft, the reason held as an open question, and a
    // new signature once that question is settled.
    const questions = questionsPath(tasksDir, id);
    await writeNote(tasksDir, {
      task: id,
      seq,
      status: "规格被人工退回（clarify）：回答 questions.md 或修订 spec 后重新 approve",
      done: "人工判定问题出在澄清/spec，而不是执行",
      found: reason,
      next: `解决 ${questions} 后执行 taskctl approve`,
      files: [],
    });
    await store.setStatus(id, "draft");
    await writeQuestions(tasksDir, id, [reason], "rejection");
  } else {
    await writeNote(tasksDir, { task: id, seq, status: "rejected", done: "人工放行未通过", found: reason, next: reason, files: [] });
    await store.setStatus(id, "open");
  }
  await appendJournal(tasksDir, id, { stage: "human", event: "rejected", detail: `stage=${stage} ${reason}` });
  await appendAudit(tasksDir, { task: id, at: new Date().toISOString(), verdict: "fail", stage, note: reason });
  await recordHumanFeedback(tasksDir, task, log, { action: "reject", verdict: "fail", stage, note: reason });
  log(`${id}  ${stage === "clarify" ? "draft" : "open"}  rejected (stage=${stage})`);
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
  if (note !== undefined) {
    await recordHumanFeedback(tasksDir, task, log, { action: "audit", verdict, stage, note });
  }
  log(`${id}  audit ${verdict}  stage=${stage}`);
  return 0;
}

/** `taskctl metrics` — which stage a human keeps failing, and how often work comes back, and whose doing it was. */
async function metricsCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const tasks = await new TaskStore(tasksDir).list();
  for (const line of [...summarizeAudits(await readAudits(tasksDir)), ...await readFlow(tasksDir, tasks)]) {
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
  const reviewPending = findings.verdict === "retry-allowed"
    && await readRuntime(tasksDir, findings.id, "review-pending.json") !== null;
  if (findings.verdict === "retry-allowed") {
    log(`  next: taskctl retry --task ${findings.id}${reviewPending ? " --review-only" : ""}`);
  }
  if (findings.verdict === "manual-review") {
    log("  next: confirm the execution is really gone, then reconcile the evidence by hand (ADR-0007)");
  }
  return 0;
}

/** `taskctl retry --task <id>` — reopen work, or only finish a preserved review. */
async function retryCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const cfg = await configFor(flags);
  const id = flags.get("task")!;
  if (flags.has("review-only")) {
    const store = new TaskStore(tasksDir);
    const task = await store.get(id);
    const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
    const outcome = await runTask({ ...cfg, tasksDir }, {
      store, adapter,
      ...(deps.acceptance === undefined ? {} : { acceptance: deps.acceptance }),
      ...(deps.review === undefined ? {} : { review: deps.review }),
      onEvent: (evt) => log(`[${evt.taskId}] ${evt.type}${evt.detail ? ` ${evt.detail}` : ""}`),
    }, task, `review-only-${process.pid}-${id}`, { reviewOnly: true });
    await refreshBoardFile(tasksDir).catch(() => {});
    log(outcome === "done" || outcome === "awaiting-human" || outcome === "open"
      ? `review-only recovery finished: ${outcome}`
      : `review-only recovery refused or still unavailable: ${outcome}`);
    return outcome === "done" || outcome === "awaiting-human" || outcome === "open" ? 0 : 1;
  }
  const outcome = await retryTask(tasksDir, id, { baseWorkdir: cfg.workdir });
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

function parseExecution(value: string): TaskExecution {
  const allowed: TaskExecution[] = ["continuous", "iterative"];
  if (!allowed.includes(value as TaskExecution)) {
    throw new UsageError(`unknown --execution "${value}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as TaskExecution;
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
  "modelCooldownMs",
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
  "batchMaxTasks",
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
    modelCooldownMs: number(raw, "modelCooldownMs", path),
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
    batchMaxTasks: integer(raw, "batchMaxTasks", path) ?? 5,
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
