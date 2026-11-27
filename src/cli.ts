import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { LOCK_TTL_MS_DEFAULT } from "./claim.js";
import { latestNote, writeNote } from "./handoff.js";
import { TaskStore } from "./task-store.js";
import { runTask, runWorker, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "./worker.js";
import { runScheduler } from "./scheduler.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type { AgentAdapter } from "./adapters/types.js";
import { serializeTaskFile, type Task, type TaskExecution, type TaskVerify, TASK_SCHEMA } from "./task-file.js";
import { buildFinding } from "./findings.js";
import { LANES, buildClarifyPrompt, detectType, nextTaskId, parseLane, parseIntakeAssessment, TEMPLATES, type ManagementLane, type TaskType } from "./intake.js";
import { appendObservation, readProfile } from "./profile.js";
import { extractCriteria, readSpec, SpecError, writeSpec } from "./spec.js";
import { appendJournal } from "./journal.js";
import type { AcceptanceResult } from "./acceptance.js";
import { createCoalescedRefresh, renderBoardMarkdown, renderBoardTable, writeBoard } from "./board.js";
import { buildReport } from "./report.js";
import { readAudits, summarizeAudits, appendAudit, type AuditStage } from "./audit.js";
import { appendLaneExample, readLaneExamples, renderLanes } from "./lanes.js";
import { readRelevantFeedback, recordTaskFeedback, type FeedbackEvent } from "./feedback.js";
import { readFixedSources, sourcesDetail } from "./context.js";
import { ADJUDICATED, humanTouches, modelFirstPass, readFlowInput, SIGN_OFF, summarizeFlow, type HumanTouch, type ModelFirstPass } from "./metrics.js";
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
import { judgeRefs, policyOf, renderVerdicts, reviewerModels, workerModels, type ModelVerdict } from "./budget.js";
import { directModel } from "./models.js";
import { modelRoundsOf, modelWaitHold, newRunContext, readModelWait } from "./model-wait.js";
import { outageReport, renderOutageReport, statusLineFromNote, stuckLines } from "./stuck.js";
import { createStopNow, processSignalSource, requestStop, type SignalSource, type StopNow, type StopSignal } from "./stop.js";
import { watchQueue, type WatchEnd, type WatchOptions } from "./watch.js";
import { createMempalaceBackend, runRecall, type MemoryBackend, type RecallInput, type RecallRecord } from "./memory.js";

/** Injection seams for tests: adapter (for `add`/`run`), acceptance gate, clock, output. */
export type CliDeps = {
  adapter?: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  /** Test seam for review-only recovery without starting a reviewer agent. */
  review?: WorkerDeps["review"];
  /** Test seam: what answers instead of the MemPalace server, for run, watch and recall; production leaves it absent. */
  memory?: MemoryBackend;
  /** Test seam: a controllable interrupt source; production polls `.taskctl/stop-now.requested`. */
  stop?: StopNow;
  /** Test seam for SIGINT/SIGTERM; production listens on the process. Never emit a real signal in a test. */
  signals?: SignalSource;
  /** Test seam for the one lane question `add` asks a terminal; production asks on the terminal. */
  askLane?: (question: string) => Promise<string | null>;
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
  /**
   * The line of a task the budget guard refused: no model session was started
   * for it and no attempt was recorded, so the line goes to the operator's
   * `--log` file when there is one, and never into the task's own directory.
   * "Unclaimed" describes the task once the refusal has returned, on both of
   * its paths: normally nothing was claimed; after the second judgement
   * (`runTask` in `./worker.ts`) the claim's lock record and the workspace
   * reservation had been written, and both were released again.
   */
  writeUnclaimedLine: (line: string) => void;
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
  const appendLine = (target: string, line: string): void => {
    logJob = logJob.then(async () => {
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, `${new Date().toISOString()}  ${line}\n`, "utf8");
    }).catch(() => {
      // A log write that cannot happen must not take the controller down.
    });
  };
  return {
    refreshBoard: boardRefresh.request,
    writeLogLine: (taskId, line) => {
      appendLine(teeTarget ?? join(cfg.tasksDir, taskId, "logs", `run-${runStamp}.log`), line);
    },
    writeUnclaimedLine: (line) => {
      if (teeTarget !== undefined) appendLine(teeTarget, line);
    },
    flush: async () => {
      boardRefresh.request();
      await boardRefresh.flush();
      await logJob;
    },
  };
}

function createWorkerDeps({
  deps, adapter, store, telemetry, log, observe, stop,
}: {
  deps: CliDeps; adapter: AgentAdapter; store: TaskStore;
  telemetry: ControllerTelemetry; log: (line: string) => void;
  /** Sees every worker event after it is logged; a controller counts what it must report. */
  observe?: (evt: WorkerEvent) => void;
  /** The controller's interrupt source; absent when the command takes no stop. */
  stop?: StopNow;
}): WorkerDeps {
  return {
    store,
    adapter,
    ...(deps.acceptance === undefined ? {} : { acceptance: deps.acceptance }),
    ...(deps.review === undefined ? {} : { review: deps.review }),
    ...(deps.memory === undefined ? {} : { memory: deps.memory }),
    ...(stop === undefined ? {} : { stop }),
    onEvent: (evt) => {
      const line = workerEventLine(evt);
      log(line);
      if (evt.type === "refused") {
        // The budget guard said no, so no attempt of the task started: none of
        // its lines go into its directory, this one included. Normally nothing
        // was claimed at all; after the second judgement the claim's lock
        // record and the reservation had been written, and both were released
        // again (`writeUnclaimedLine`). The verdicts in the line are what the
        // operator reads.
        telemetry.writeUnclaimedLine(line);
      } else {
        telemetry.writeLogLine(evt.taskId, line);
        telemetry.refreshBoard();
      }
      observe?.(evt);
    },
  };
}

/** One controller's interrupt bookkeeping: what the operator asked, what that interrupted, and what to say about it. */
type ControllerStop = {
  now: StopNow;
  /** Counts what the controller must report: interrupted attempts, and unconfirmed ones. */
  observe(evt: WorkerEvent): void;
  /** Undefined when nothing asked this controller to stop. */
  exitCode(): number | undefined;
  /** One line on `log` saying what was interrupted, or what needs reconciliation. */
  report(label: "scheduler" | "watch", log: (line: string) => void): void;
  close(): Promise<void>;
};

/**
 * The interrupt source one `run`, `watch` or `retry --review-only` controller
 * holds: the injected test seam when there is one, otherwise a real source on
 * the board that turns SIGINT/SIGTERM into the same durable request. The
 * handler never exits the process and never forces anything — the stop is
 * bounded by the worker's cancel deadline, and a repeated signal only says the
 * controller is still stopping (D7). It is closed by every command that
 * created it, so no other command carries the relay (D10).
 */
async function createControllerStop(cfg: ResolvedConfig, deps: CliDeps, log: (line: string) => void, err: (line: string) => void): Promise<ControllerStop> {
  let owned: (StopNow & { close(): Promise<void> }) | undefined;
  let seenSignal = false;
  // Repeated signals queue behind the first: they write the same request, and
  // two writes racing on one temporary path can leave the second rename with
  // nothing left to move. Chained, the second write follows the first.
  let relay: Promise<void> = Promise.resolve();
  const onSignal = (signal: StopSignal): Promise<void> => {
    const first = !seenSignal;
    seenSignal = true;
    log(first
      ? `[taskctl] ${signal} received: running work is interrupted; nothing new is claimed`
      : `[taskctl] ${signal} received again: still stopping`);
    relay = relay.then(async () => {
      // D2: the signal leaves the same two durable files `stop --now` writes.
      // A request that cannot be written is reported and never thrown: this
      // promise is awaited by close(), and the controller must still end itself.
      try {
        await requestStop(cfg.tasksDir, "now");
      } catch (error) {
        err(`stop request could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch(() => {
      // The signal handler never rejects (Task 1): a failed `err` write must
      // not become the controller's problem, so the queue keeps going.
    });
    return relay;
  };
  const now = deps.stop !== undefined
    ? deps.stop
    : (owned = await createStopNow(cfg.tasksDir, { signals: deps.signals ?? processSignalSource(), onSignal }));
  const stopped: string[] = [];
  const unconfirmed: string[] = [];
  const count = (ids: string[], taskId: string): void => { if (!ids.includes(taskId)) ids.push(taskId); };
  return {
    now,
    observe: (evt) => {
      // A `refused` event is neither: nothing was claimed, so nothing was interrupted (D11).
      if (evt.type === "stopped") count(stopped, evt.taskId);
      if (evt.type === "stop-unconfirmed") count(unconfirmed, evt.taskId);
    },
    exitCode: () => {
      if (!now.isRequested()) return undefined;
      if (unconfirmed.length > 0) return 1;
      const source = now.source();
      return source !== undefined && source in SIGNAL_EXIT_CODES ? SIGNAL_EXIT_CODES[source as StopSignal] : 0;
    },
    report: (label, line) => {
      line(`[${label}] stopped by the operator${stopped.length > 0 ? `: ${stopped.join(", ")}` : ""}; run again to continue`);
      if (unconfirmed.length > 0) {
        line(`[${label}] stopped by the operator, but ${unconfirmed.length} interrupted attempt(s) could not be confirmed and need reconciliation: ${unconfirmed.join(", ")}`);
      }
    },
    close: async () => {
      await owned?.close();
    },
  };
}

/** The agent CLI of a controller that cancels turns itself: insulated from the console's Ctrl-C. */
function controllerAdapter(cfg: ResolvedConfig): OpenCodeAdapter {
  return new OpenCodeAdapter({ bin: cfg.opencodeBin, insulated: true });
}

/** Usage problem (unknown command/flag, missing value): exit code 2. */
class UsageError extends Error {}

/** The run stopped because every model refused (design §7): exit code 3, whatever else happened in it. */
export const EXIT_OUTAGE = 3;

/** Exit code of a controller that was stopped: the signal's own number, or 0 for a request from the board; 1 outranks both when an interrupted attempt is uncertain. */
export const SIGNAL_EXIT_CODES: Readonly<Record<StopSignal, number>> = { SIGINT: 130, SIGTERM: 143 };

const USAGE = [
  "usage:",
  "  taskctl add \"<意图>\" (--quick|--simple|--complex) [--type code|office|research|design] [--verify human|mechanical|render] [--execution continuous|iterative] [--target <a.html,b.html>] [--id <id>] [--config taskctl.json]",
  "  taskctl spec --task <id> [--tasks-dir <dir>]",
  "  taskctl split --task <id> [--apply] [--tasks-dir <dir>] [--config taskctl.json]",
  "  taskctl approve --task <id> [--tasks-dir <dir>]",
  "  taskctl answer --task <id> --file <path> [--tasks-dir <dir>]",
  "  taskctl run [--batch <id,id,…>] [--log <file>] [--config taskctl.json]",
  "  taskctl watch --config <file> [--resume]",
  "  taskctl stop --tasks-dir <dir> [--now]",
  "  taskctl verify --task <id> [--viewport 1440x900,390x844] [--config taskctl.json]",
  "  taskctl done --task <id> [--tasks-dir <dir>]",
  "  taskctl check --task <id> [--tasks-dir <dir>]",
  "  taskctl note --task <id> --status <s> --done <d> --found <f> --next <n> [--files <a,b>] [--tasks-dir <dir>]",
  "  taskctl status [--stuck] [--tasks-dir <dir>]",
  "  taskctl board [--all] [--json] [--tasks-dir <dir>]",
  "  taskctl report --task <id> [--tasks-dir <dir>]",
  "  taskctl accept --task <id> [--note \"…\"] [--tasks-dir <dir>]",
  "  taskctl reject --task <id> --reason \"…\" [--stage clarify|worker|reviewer] [--tasks-dir <dir>]",
  "  taskctl audit --task <id> --verdict pass|fail [--stage …] [--note \"…\"] [--tasks-dir <dir>]",
  "  taskctl metrics [--tasks-dir <dir>]",
  "  taskctl lanes [--tasks-dir <dir>]",
  "  taskctl recall (--task <id> | --query <text>) [--config taskctl.json]",
  "  taskctl models [--config taskctl.json]",
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

/**
 * Resolve the config file for commands that need settings beyond `tasksDir`,
 * keeping the path it was read from (`configPath`): the artifact digest leaves
 * that file out when it lies in the work directory (`digestExclusions`,
 * src/worker.ts).
 */
async function configFor(flags: Map<string, string>): Promise<ResolvedConfig> {
  const path = flags.get("config") ?? "taskctl.json";
  return { ...resolveConfig(await readConfig(path), path), configPath: path };
}

/** The one question `add` asks a terminal when the operator gave no lane flag. */
export const LANE_QUESTION = [
  "taskctl add needs the lane of this task:",
  "  quick    no spec and no signature: the intent is the whole definition",
  "  simple   a spec, no signature: worker, then one review",
  "  complex  a spec that waits for your signature",
  "lane (quick/simple/complex):",
].join("\n");

/** The usage error when the operator declared no lane. */
const LANE_MISSING = "add requires a lane: pass --quick, --simple or --complex";

/**
 * Ask the lane on the terminal. Not attached to one, nothing is asked and the
 * answer is `null` at once; end of input on a terminal is no lane either.
 */
export async function askOnTerminal(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string | null> {
  if ((input as NodeJS.ReadStream).isTTY !== true) return null;
  const rl = readline.createInterface({ input, output });
  // End of input is no lane: the question must not wait for ever.
  const answer = await Promise.race([
    rl.question(`${question}\n`),
    new Promise<null>((resolve) => rl.once("close", () => resolve(null))),
  ]);
  rl.close();
  return answer;
}

/** The lane the operator declared: one flag, else one question; never the wording of the intent. */
async function declaredLane(flags: Map<string, string>, deps: CliDeps): Promise<ManagementLane> {
  const given = LANES.filter((lane) => flags.has(lane));
  if (given.length > 1) {
    throw new UsageError("--quick, --simple and --complex are mutually exclusive: declare exactly one lane");
  }
  if (given.length > 0) return given[0]!;
  const reply = await (deps.askLane ?? askOnTerminal)(LANE_QUESTION);
  if (reply === null) throw new UsageError(LANE_MISSING);
  const lane = parseLane(reply);
  if (lane === null) {
    throw new UsageError(`${LANE_MISSING} ("${reply}" is not a lane)`);
  }
  return lane;
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
 * Returns the process exit code: 0 ok, 1 runtime error, 2 usage error, 3 a stop
 * for an outage (`run`, `watch`, `EXIT_OUTAGE`).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  try {
    return await dispatch(argv, deps, log, err);
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

async function dispatch(argv: string[], deps: CliDeps, log: (line: string) => void, err: (line: string) => void): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  if (command === undefined) {
    throw new UsageError("missing command");
  }
  if (positionals.length > 0 && command !== "add") {
    throw new UsageError(`unexpected argument "${positionals[0]}"`);
  }
  switch (command) {
    case "add":
      checkFlags(command, flags, ["type", "simple", "quick", "complex", "verify", "execution", "target", "id", "config", "risk", "workdir", "tasks-dir", "acceptance"], []);
      return addCommand(positionals, flags, deps, log, err);
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
      return splitCommand(flags, deps, log, err);
    case "run":
      checkFlags(command, flags, ["config", "log", "batch"], []);
      return runCommand(flags, deps, log, err);
    case "watch":
      checkFlags(command, flags, ["config", "resume"], ["config"]);
      return watchCommand(flags, deps, log, err);
    case "stop":
      checkFlags(command, flags, ["tasks-dir", "now"], ["tasks-dir"]);
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
      checkFlags(command, flags, ["tasks-dir", "config", "stuck"], []);
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
    case "lanes":
      checkFlags(command, flags, ["tasks-dir", "config"], []);
      return lanesCommand(flags, log);
    case "recall":
      checkFlags(command, flags, ["config", "task", "query"], []);
      return recallCommand(flags, deps, log, err);
    case "models":
      checkFlags(command, flags, ["config"], []);
      return modelsCommand(flags, deps, log);
    case "learn":
      checkFlags(command, flags, ["note", "tasks-dir", "config"], ["note"]);
      return learnCommand(flags, log);
    case "reconcile":
      checkFlags(command, flags, ["task", "tasks-dir", "config"], ["task"]);
      return reconcileCommand(flags, log);
    case "retry":
      checkFlags(command, flags, ["task", "tasks-dir", "config", "review-only"], ["task"]);
      return retryCommand(flags, deps, log, err);
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
async function runCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void, err: (line: string) => void): Promise<number> {
  // One run context for the whole command: the attempts and the controller's
  // decision read the same evidence, so a deferral this process wrote is one
  // this process decides (a new run, watch or retry process is a new run).
  const cfg = { ...(await configFor(flags)), run: newRunContext() };
  const adapter = deps.adapter ?? controllerAdapter(cfg);
  const store = deps.store ?? new TaskStore(cfg.tasksDir);
  // Controller log: with --log every event line is teed to one operator-chosen
  // file; by default each task's lines land in its own task dir under logs/.
  // This replaces the external `Tee-Object` into the workspace root that
  // motivated task 006 — the controller now keeps its own hygiene.
  const teeTarget = flags.get("log") !== undefined ? resolve(flags.get("log")!) : undefined;
  // The telemetry comes before the relay: creating it can throw (an unwritable
  // --log path), and a throw before the `try` below must not leave the signal
  // handler installed on a process that is already ending.
  const telemetry = await createControllerTelemetry(cfg, teeTarget);
  // The run's interrupt source: it reads the board from here on, so a request
  // older than this run is its baseline and stops nothing (Review Focus 5).
  const stop = await createControllerStop(cfg, deps, log, err);
  telemetry.refreshBoard();
  let controllerErrors = 0;
  const workerDeps = createWorkerDeps({
    deps, adapter, store, telemetry, log, stop: stop.now,
    observe: (evt) => { if (evt.type === "controller-error") controllerErrors += 1; stop.observe(evt); },
  });
  const batch = flags.get("batch");
  const result = await (async () => {
    try {
      return batch === undefined
        ? await runScheduler(cfg, workerDeps)
        : await runBatch(cfg, workerDeps, batch.split(","));
    } finally {
      // The relay goes first: close awaits the last requestStop a signal
      // started, so the requests are on the board before the run reports, and
      // the handlers are off the process before the exit code is chosen.
      await stop.close();
      // Validation can fail before any event. Still settle the trailing board
      // refresh and queued log writes before the CLI returns or throws.
      await telemetry.flush();
    }
  })();
  if (batch !== undefined && "stoppedAt" in result && result.stoppedAt !== undefined) {
    log(`[batch] stopped at ${result.stoppedAt} (${result.outcome})${result.deferredUntil === undefined ? "" : `; deferred until ${result.deferredUntil}, run again then`}; unclaimed: ${result.pending.join(", ") || "none"}`);
  } else if (result.pending.length > 0) {
    // Work left in `open` with no explanation reads as "nothing to do". It is not.
    log(
      `[scheduler] stopped at the pass budget with ${result.pending.length} ready task(s) not started: `
      + `${result.pending.join(", ")}. Run taskctl run again to continue.`,
    );
  }
  // The report a stop for an outage owes the operator (design §7), printed
  // beside whatever else this run has to say.
  const outageTaskId = batch === undefined
    ? ("outage" in result ? result.outage?.taskId : undefined)
    : "stoppedAt" in result && result.stoppedAt !== undefined && result.outcome === "outage" ? result.stoppedAt : undefined;
  if (outageTaskId !== undefined) {
    for (const line of renderOutageReport(await outageReport(cfg, await store.list(), outageTaskId))) log(line);
  }
  // Each is said when its own count is above zero, the controller errors
  // first: a run with both must not let the earlier return hide the later line.
  // Part 1 prints these before any exit-code decision, so an outage or a stop
  // still says what else the run saw.
  if (controllerErrors > 0) {
    // A task blocked by a controller bug is not an ordinary outcome. The board
    // was still drained, but the run must not read as clean to a script.
    log(`[scheduler] ${controllerErrors} task(s) blocked by a controller error; see the controller-error line(s) above`);
  }
  // What was refused is read off the result, never off the events: those are
  // reported once per process per task, and an exit code must not depend on
  // what happened earlier in this process.
  const refused = batch === undefined
    // `runScheduler` names every task it refused.
    ? ("refused" in result ? result.refused ?? [] : [])
    // A batch stops on the first task that was refused.
    : "stoppedAt" in result && result.stoppedAt !== undefined && result.outcome === "refused"
      ? [result.stoppedAt]
      : [];
  if (refused.length > 0) {
    // The guard's verdicts are in the `refused` line(s) above. The board was
    // still drained, but a task that did not run must not read as clean to a script.
    log(`[scheduler] ${refused.length} task(s) refused by the budget guard; no model session was started for them`);
  }
  // The code names why the run stopped, in D1's order: an interrupted attempt
  // that could not be confirmed outranks everything; part 1's outage return is
  // next (a stop never takes that decision, D13b, so the two do not meet);
  // then the stop's own report, printed beside whatever makes the run exit 1
  // anyway — a controller error, a refused task — whose code wins over the
  // stop's; and only a stop with nothing else to say is the exit code itself.
  const code = stop.exitCode();
  if (code === 1) {
    stop.report("scheduler", log);
    return 1;
  }
  // An outage is 3 whatever else happened — refused tasks and controller
  // errors are printed beside the report (part 1, design §7).
  if (outageTaskId !== undefined) return EXIT_OUTAGE;
  if (stop.now.isRequested()) stop.report("scheduler", log);
  if (controllerErrors > 0) return 1;
  if (refused.length > 0) return 1;
  return code ?? 0;
}

/** `taskctl watch` — own and drain one board until its stop request appears. */
async function watchCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void, err: (line: string) => void): Promise<number> {
  // One run context for the whole command, as `run` builds one: the attempts
  // and the controller's decision read the same evidence, so a deferral this
  // process wrote is one this process decides.
  const cfg = { ...(await configFor(flags)), run: newRunContext() };
  const adapter = deps.adapter ?? controllerAdapter(cfg);
  const store = deps.store ?? new TaskStore(cfg.tasksDir);
  const telemetry = await createControllerTelemetry(cfg);
  // The watch's interrupt source, as `run` builds one: created before the
  // queue starts, so a request on the board when it starts is its baseline,
  // and `watch --resume` clearing it a moment later is no stop. It comes after
  // the telemetry, so nothing that throws in between leaves a relay behind.
  const stop = await createControllerStop(cfg, deps, log, err);
  telemetry.refreshBoard();
  let end: WatchEnd;
  try {
    end = await watchQueue(cfg, createWorkerDeps({
      deps, adapter, store, telemetry, log, stop: stop.now,
      // The watch counts what it must report exactly as `run` does: an
      // interrupted attempt that could not be confirmed is its own line and 1.
      observe: (evt) => stop.observe(evt),
    }),
      {
        ...deps.watch,
        resume: flags.has("resume"),
        onError: deps.watch?.onError ?? ((message) => (deps.err ?? log)(message)),
      });
  } finally {
    await stop.close();
    await telemetry.flush();
  }
  // The code names why the watch ended, in D1's order. `WatchEnd` says "stop"
  // for an operator's stop as for a graceful one, so the code reads the
  // source: an unconfirmed interrupted attempt is 1 whatever asked; the queue's
  // own outage report comes next; then the operator's code, reported like
  // `run` reports it. A guard refusal changes nothing here and still returns 0.
  const code = stop.exitCode();
  if (code === 1) {
    stop.report("watch", log);
    return 1;
  }
  if (end.reason === "outage") {
    for (const line of renderOutageReport(await outageReport(cfg, await store.list(), end.taskId))) log(line);
    return EXIT_OUTAGE;
  }
  if (code !== undefined) {
    stop.report("watch", log);
    return code;
  }
  return 0;
}

/** What a recall is asked for a task: its own words, and its spec whole. */
async function taskRecallInput(tasksDir: string, id: string): Promise<Omit<RecallInput, "at">> {
  const task = await new TaskStore(tasksDir).get(id);
  return { title: task.title, description: task.description, spec: await readSpec(tasksDir, id) };
}

/**
 * `taskctl recall (--task <id> | --query <text>)` — show what a recall
 * finds, and write nothing: no `recall.json`, no journal line.
 *
 * A read-only preview of the step a worker attempt takes when it starts
 * (`readSections` in `./worker.ts`), through the same `runRecall`, so what is
 * printed here is what the prompt would carry. `--task` asks with a task's
 * own words and its spec's goal; `--query` asks with a query written by hand,
 * to tune the cut-off or to reproduce an earlier recall. Either way the query
 * is normalised as every recall query is: whitespace collapsed, 250
 * characters at most.
 *
 * The fixed sources are shown first, as they are placed in the prompt, and
 * whether memory is on or not: one line saying how each file was read, then
 * the files as the prompt carries them. A file that is missing or cannot be
 * read is said on a line of its own — by file name and state, never by path
 * — and the exit code is 1, whatever memory then found.
 *
 * Exit code 0 when something was kept and when nothing was — an empty memory
 * is an answer — and 1 when the backend could not answer in time or at all,
 * or when a fixed source could not be read. With memory off there is nothing
 * to ask; that is said, and is no failure.
 */
async function recallCommand(
  flags: Map<string, string>, deps: CliDeps, log: (line: string) => void, err: (line: string) => void,
): Promise<number> {
  const id = flags.get("task");
  const query = flags.get("query");
  // Said before anything is read or asked.
  if ((id === undefined) === (query === undefined)) {
    throw new UsageError("recall needs exactly one of --task <id> and --query <text>");
  }
  if (query !== undefined && query.trim().length === 0) {
    throw new UsageError("recall needs text after --query");
  }
  const cfg = await configFor(flags);
  // The fixed sources come first, as they do in the prompt, and whether memory is on or not. `readFixedSources`
  // never throws: a file that cannot be read costs a line to `err` and the exit code, never the rest of the preview.
  let sourceFailed = false;
  if (cfg.fixedSources !== undefined && cfg.fixedSources.length > 0) {
    const { text, files } = await readFixedSources(cfg.fixedSources);
    log(`fixed sources: ${sourcesDetail(files)}`);
    // The blocks as the prompt carries them: nothing at all when no file could be read.
    for (const line of text === undefined ? [] : text.split("\n")) log(line);
    for (const { name, state, detail } of files) {
      if (state !== "missing" && state !== "unreadable") continue;
      err(`source unavailable: ${name} (${state}${detail === undefined ? "" : `: ${detail}`})`);
      sourceFailed = true;
    }
  }
  if (cfg.memory === undefined || cfg.memory.backend === "none") {
    log('memory backend is "none"; nothing to recall');
    return sourceFailed ? 1 : 0;
  }
  const at = new Date().toISOString();
  const input: RecallInput = id === undefined
    // A query written by hand is the whole of the input: nothing is added to it.
    ? { title: query!, description: "", spec: null, at }
    : { ...(await taskRecallInput(cfg.tasksDir, id)), at };
  // The record is kept for the lines below; neither it nor a journal line is written anywhere.
  let record: RecallRecord | undefined;
  const text = await runRecall(cfg.memory, deps.memory ?? createMempalaceBackend(cfg.memory), input, {
    write: async (written) => { record = written; },
    journal: async () => {
      // A preview leaves no journal line.
    },
  });
  if (record === undefined) throw new Error("recall left no record of itself");
  log(`query: ${record.query}`);
  log(
    `backend: ${record.backend}, outcome: ${record.outcome}, hits: ${record.hits.length}, `
    + `below=${record.filtered.belowThreshold} room=${record.filtered.room} wing=${record.filtered.wing}`
    + (record.truncated ? ", truncated" : ""),
  );
  // One line per hit, as the worker prompt shows them; nothing when none was kept.
  for (const line of text === null ? [] : text.split("\n")) log(line);
  if (record.outcome === "timeout" || record.outcome === "error") {
    err(`recall unavailable: ${record.outcome}${record.detail === undefined ? "" : `: ${record.detail}`}`);
  }
  return (record.outcome === "ok" || record.outcome === "no-hits") && !sourceFailed ? 0 : 1;
}

/**
 * `taskctl models [--config taskctl.json]` — what the budget guard will
 * allow, seen before anything is offered: one line per model this
 * configuration can run a task on, with the guard's verdict.
 *
 * Read-only. The backend is asked only for its catalogue and its default
 * model, never for a session. A line comes from the verdict's own fields
 * (`renderVerdicts`): a catalogue entry carries credentials, so nothing else
 * of it is here to print.
 *
 * The models are the lists the guard judges before a claim (`checkModels`
 * in `./budget.ts`), in this order: the worker's chain, the reviewer's
 * chain, the `model` of every task on the board that is not `done`, and —
 * where a chain is empty — the backend's default, which is what that role
 * then runs on. Each list is judged once, on its own; a model that already
 * has a line is not listed again.
 *
 * Exit 1 when any line is refused: that is what `run` would refuse too. An
 * adapter that cannot list models is not guarded at all; that is said, and
 * is no failure. It takes no `--tasks-dir`: the board is the one the
 * configuration names, as it is for `run`.
 */
async function modelsCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const cfg = await configFor(flags);
  const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
  // What makes `catalogueOf` answer `null` in `./budget.ts`, and the guard
  // stand aside. Asked of the adapter itself, not of a read of the backend:
  // a catalogue that cannot be read is no "no catalogue", it is the refusal
  // every line below then carries.
  if (typeof adapter.modelCatalog !== "function") {
    log("此适配器不提供模型目录，护栏不生效");
    return 0;
  }
  const board = await new TaskStore(cfg.tasksDir).list();
  const policy = policyOf(cfg);
  const lists: readonly (readonly string[])[] = [
    // The configuration's own chain: what a task without a model of its own runs on.
    workerModels(cfg, { model: undefined } as Task),
    reviewerModels(cfg),
    ...board.flatMap((task) => task.status !== "done" && task.model !== undefined ? [[task.model]] : []),
  ];
  // Asked together, in the configured workdir (where a session would start): every list reads the same catalogue,
  // so a backend that is slow or down is asked once.
  const judged = await Promise.all(lists.map((refs) => judgeRefs(refs, policy, adapter, undefined, cfg.workdir)));
  const verdicts: ModelVerdict[] = [];
  for (const list of judged) {
    for (const verdict of list) {
      if (!verdicts.some((listed) => listed.ref === verdict.ref)) verdicts.push(verdict);
    }
  }
  log("模型与护栏判定：");
  const lines = renderVerdicts(verdicts);
  if (lines.length > 0) {
    for (const line of lines.split("\n")) log(line);
  }
  return verdicts.some((verdict) => !verdict.allowed) ? 1 : 0;
}

/** `taskctl stop [--now]` — request a drain; `--now` also asks for running work to be interrupted. Never signals a process itself. */
async function stopCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const now = flags.has("now");
  const path = await requestStop(tasksDir, now ? "now" : "graceful");
  log(now ? `stop requested now: ${path} (running work is interrupted)` : `stop requested: ${path}`);
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

/**
 * The budget guard for a session that runs on one model — `model`, else the
 * head of `modelChain`, else the backend's default: the clarify session of
 * `add`, the planner session of `split`. The verdicts that were not allowed;
 * empty when the session may start. An adapter that cannot list models is not
 * guarded.
 */
async function sessionRefusals(cfg: ResolvedConfig, adapter: AgentAdapter): Promise<ModelVerdict[]> {
  // Asked in `cfg.workdir`: the directory the session starts in, which the backend answers by.
  const judged = directModel(cfg);
  const verdicts = await judgeRefs(judged === undefined ? [] : [judged], policyOf(cfg), adapter, undefined, cfg.workdir);
  return verdicts.filter((verdict) => !verdict.allowed);
}

/** `taskctl add "<intent>"` — capture the intent, draft the spec, gate the state. */
async function addCommand(
  positionals: string[],
  flags: Map<string, string>,
  deps: CliDeps,
  log: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const intent = positionals.join(" ").trim();
  if (intent.length === 0) {
    throw new UsageError("add requires the intent as an argument");
  }
  const lane = await declaredLane(flags, deps);
  const configPath = flags.get("config") ?? "taskctl.json";
  const cfg = resolveConfig(await readConfig(configPath), configPath);
  const tasksDir = flags.get("tasks-dir") ? resolve(flags.get("tasks-dir")!) : cfg.tasksDir;
  await mkdir(tasksDir, { recursive: true });
  const store = new TaskStore(tasksDir);
  const id = flags.get("id") ?? (await nextTaskId(tasksDir, intent));
  const type = parseType(flags.get("type") ?? detectType(intent));
  const acceptance = flags.get("acceptance");
  const quick = lane === "quick";
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
  const complexity = lane === "complex" ? "complex" : "simple";
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

  const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
  // Before anything is written: a clarify session the budget guard refuses
  // leaves no task file behind. A quick task has no session, so it is not asked.
  if (!quick) {
    const disallowed = await sessionRefusals(cfg, adapter);
    if (disallowed.length > 0) {
      err(renderVerdicts(disallowed));
      throw new Error(`budget guard refused: ${disallowed.map((verdict) => verdict.ref).join(", ")}`);
    }
  }
  await writeFile(join(tasksDir, `${id}.md`), serializeTaskFile(task), { encoding: "utf8", flag: "wx" });
  // The task file is the boundary: an `add` that ends before that write leaves
  // nothing on the board, so the lane example below is appended on every path
  // past it — including a clarify session that fails and the quick lane.
  let criteriaCount = 0;
  try {
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

    const profile = await readProfile(tasksDir);
    const feedback = await relevantFeedback(tasksDir, { type, intent }, log);
    const prompt = buildClarifyPrompt({ task, type, profile, ...(feedback === null ? {} : { feedback }) });
    const result = await adapter.prompt({
      text: prompt,
      cwd: cfg.workdir,
      model: directModel(cfg),
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
      criteriaCount = criteria.length;
    } catch (err) {
      await appendJournal(tasksDir, id, {
        stage: "clarify",
        event: "spec-invalid",
        detail: err instanceof Error ? err.message : String(err),
      });
      log(`${id}  draft  spec-invalid`);
      return 1;
    }
    const assessment = parseIntakeAssessment(specText);
    await store.updateFields(id, { criteria });
    await writeRuntime(tasksDir, id, "classification.json", {
      lane, source: "operator",
      sufficiency: assessment.sufficiency,
      reason: assessment.reason, model: directModel(cfg) ?? "(backend-default)", type, at: new Date().toISOString(),
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
    if (complexity === "simple") {
      await store.setStatus(id, "open");
    }
    await appendJournal(tasksDir, id, {
      stage: "clarify",
      event: "spec-drafted",
      detail: `criteria=${criteria.length} lane=${lane} sufficiency=${assessment.sufficiency}`,
    });
    log(`${id}  ${complexity === "simple" ? "open" : "draft"}  lane=${lane} criteria=${criteria.length}`);
    return 0;
  } finally {
    await appendLaneExample(tasksDir, {
      id, at: new Date().toISOString(), lane, type, title: task.title, intent, criteria: criteriaCount,
    }).catch((error: unknown) => log(`${id}  lane example not recorded: ${error instanceof Error ? error.message : String(error)}`));
  }
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
 *
 * Before a planner session starts, the budget guard judges the model it would
 * run on (see `src/budget.ts`). A refusal is journaled as `budget-refused`,
 * printed, and exits 1, and no plan is written.
 */
async function splitCommand(
  flags: Map<string, string>,
  deps: CliDeps,
  log: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
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
    // The planner session runs on one model, judged before it starts. A
    // refusal is this command's own doing, so it is said in the journal, on
    // stderr, and in the exit code; and no plan is written.
    const disallowed = await sessionRefusals(cfg, adapter);
    if (disallowed.length > 0) {
      await appendJournal(tasksDir, id, {
        stage: "split",
        event: "budget-refused",
        detail: disallowed.map((verdict) => verdict.ref).join(","),
      });
      err(renderVerdicts(disallowed));
      return 1;
    }
    const spec = (await readSpec(tasksDir, id)) ?? "";
    const result = await adapter.prompt({
      text: buildSplitPrompt({ parent, spec }),
      cwd: cfg.workdir,
      model: directModel(cfg),
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
        parent, spec, board: await store.list(), model: directModel(cfg) ?? "(backend-default)", now: new Date(),
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
  // The worker runs this command inside the task's workspace and cannot see
  // the controller's --config. The attempt record, written by the controller
  // at claim, is the authority for both the workspace and the turn bound; the
  // config beside the caller is only a fallback for records that predate it.
  const turnBound = attempt.turnTimeoutMs ?? cfg.turnTimeoutMs ?? 30 * 60_000;
  // An undeclared timeout is capped by the turn bound: a default longer than
  // the turn would refuse every self-check on a short-turn board.
  const timeoutMs = task.workerSelfCheckTimeoutMs ?? Math.min(20 * 60_000, turnBound);
  if (timeoutMs > turnBound) {
    throw new Error(`task ${id}: worker_self_check_timeout_ms ${timeoutMs} exceeds turnTimeoutMs ${turnBound}`);
  }
  const startedAt = new Date().toISOString();
  const result = await runSelfCheck({ command, cwd: attempt.workspace || taskWorkdir(cfg.workdir, task), timeoutMs });
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

/** `taskctl status` — one table row per task, then the files it refused to register; `--stuck` lists only what is held or waiting. */
async function statusCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const store = new TaskStore(tasksDir);
  if (flags.has("stuck")) {
    // Files only: the config for `modelRounds`/`lockTtlMs`, the board, and what
    // the attempts wrote. No adapter is built, so the guard's backend catalogue
    // is never asked — the list prints what was judged when each record was
    // written, and today's judgement is `taskctl models`' business.
    const cfg = await configFor(flags);
    for (const line of await stuckLines(tasksDir, await store.list(), cfg)) log(line);
    return 0;
  }
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
// `resume` was missing here until 2026-11-24: the usage text and the stop
// refusal both send the operator to `watch --resume`, but the parser read it
// as a value flag and exited 2, so a stopped queue could not be restarted.
const BOOLEAN_FLAGS = new Set(["simple", "quick", "complex", "all", "apply", "json", "review-only", "resume", "stuck", "now"]);

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
  // A spot check is time a person spent on the task. The audit log keeps the
  // verdict; this line lets the metrics count the touch (`humanTouches` in
  // `./metrics.ts`). It is all the journal gains: the status does not move.
  await appendJournal(tasksDir, id, {
    stage: "human",
    event: "audited",
    detail: note === undefined ? `${verdict} ${stage}` : `${verdict} ${stage}: ${note}`,
  });
  if (note !== undefined) {
    await recordHumanFeedback(tasksDir, task, log, { action: "audit", verdict, stage, note });
  }
  log(`${id}  audit ${verdict}  stage=${stage}`);
  return 0;
}

/** `taskctl metrics` — which stage a human keeps failing, how often work comes back and whose doing it was, where a person had to step in, and how each model's first review fares. */
async function metricsCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const tasks = await new TaskStore(tasksDir).list();
  // The journals are read once: the flow and the two views under it are all computed from them.
  const input = await readFlowInput(tasksDir, tasks);
  // Only a finished task says anything about how its model's first review went.
  const firstPass = modelFirstPass(await Promise.all(
    tasks.filter((task) => task.status === "done").map(async (task) => ({
      model: await acceptanceModel(tasksDir, task.id),
      journal: input.journals.get(task.id) ?? [],
    })),
  ));
  for (const line of [
    ...summarizeAudits(await readAudits(tasksDir)),
    ...summarizeFlow(input),
    ...humanTouchSection(humanTouches(input.journals)),
    ...firstPassSection(firstPass),
  ]) {
    log(line);
  }
  return 0;
}

/**
 * The model a finished task's acceptance ran on, from its `acceptance.json`.
 * A task with `verify: render` has no `acceptance.json`: the render check is
 * what accepted it, and it writes `render.json` instead. So when the record
 * is absent or names no model, the `model` of `render.json` is read. `null`
 * when neither says. A record too torn to read is one that says nothing (as
 * `readClassification` in `./metrics.ts` reads its own): the task is
 * credited to no model, and the metrics still print.
 */
async function acceptanceModel(tasksDir: string, id: string): Promise<string | null> {
  return await recordedModel(tasksDir, id, "acceptance.json")
    ?? await recordedModel(tasksDir, id, "render.json");
}

/** The `model` of one runtime record: `null` when the file is absent, cannot be parsed, or has none. */
async function recordedModel(tasksDir: string, id: string, name: string): Promise<string | null> {
  let record: { model?: unknown } | null;
  try {
    record = await readRuntime<{ model?: unknown }>(tasksDir, id, name);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  return typeof record?.model === "string" ? record.model : null;
}

/**
 * The section `人工触点`: the two kinds of touch and which events are which
 * — read off the sets themselves, so the line cannot drift from what is
 * counted — then what the waiting time is, an approximation said every time.
 * After them one line per task a person touched: its touches under each
 * kind, the ones in neither kind when there are any, the touches by event,
 * and how long it waited for them. The totals over the tasks close the
 * section, and only when there is at least one task; `（无）` when there is
 * none.
 */
function humanTouchSection(touches: readonly HumanTouch[]): string[] {
  const byKind = (byEvent: Record<string, number>): string =>
    Object.entries(byEvent).map(([event, count]) => `${event}×${count}`).join(", ");
  /** `共 N 次  审批 S  裁决 A`, then the touches in neither kind when there are any: the shape of a task's line and of the totals. */
  const counts = ({ total, signOff, adjudicated, other }: Pick<HumanTouch, "total" | "signOff" | "adjudicated" | "other">): string =>
    `共 ${total} 次  审批 ${signOff}  裁决 ${adjudicated}${other > 0 ? `  未归类 ${other}` : ""}`;
  const sum = touches.reduce(
    (all, touch) => ({
      total: all.total + touch.total, signOff: all.signOff + touch.signOff,
      adjudicated: all.adjudicated + touch.adjudicated, other: all.other + touch.other,
    }),
    { total: 0, signOff: 0, adjudicated: 0, other: 0 },
  );
  return [
    "人工触点",
    `审批型是签字放行（${[...SIGN_OFF].join("、")}），该往下压；裁决型是定标准、判对错（${[...ADJUDICATED].join("、")}），是判断的来源，不压`,
    "等人时长为墙钟时间，包含夜间和周末，是近似值",
    ...(touches.length === 0 ? ["（无）"] : [
      ...touches.map(({ task, byEvent, total, signOff, adjudicated, other, waitedMs }) => {
        const minutes = Math.floor(waitedMs / 60_000);
        return `${task}  ${counts({ total, signOff, adjudicated, other })}  （${byKind(byEvent)}）  等人 ${Math.floor(minutes / 60)}h${minutes % 60}m`;
      }),
      `合计  ${counts(sum)}`,
    ]),
  ];
}

/**
 * The section `按模型的首轮复核通过`: one line per model. The rate is taken
 * over the tasks that had a review at all, and is `-` when there are none.
 */
function firstPassSection(rows: readonly ModelFirstPass[]): string[] {
  return [
    "按模型的首轮复核通过",
    ...rows.map(({ model, tasks, firstReviewPassed, noReview }) => {
      const reviewed = tasks - noReview;
      const rate = reviewed === 0 ? "-" : `${Math.round((100 * firstReviewPassed) / reviewed)}%`;
      return `${model}  任务 ${tasks}  首轮通过 ${firstReviewPassed}  未复核 ${noReview}  首轮通过率 ${rate}`;
    }),
  ];
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

/** `taskctl lanes` — every declared lane, grouped. */
async function lanesCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  for (const line of renderLanes(await readLaneExamples(await tasksDirFor(flags)))) {
    log(line);
  }
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
async function retryCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void, err: (line: string) => void): Promise<number> {
  const tasksDir = await tasksDirFor(flags);
  const cfg = await configFor(flags);
  const id = flags.get("task")!;
  if (flags.has("review-only")) {
    const store = deps.store ?? new TaskStore(tasksDir);
    const task = await store.get(id);
    // The recovery is an entry point like run and watch: its agent CLI is
    // insulated (D6) and it takes the operator's interrupt (D10) — a stop
    // returns the parked task to `blocked` with its parked review intact (D3).
    const adapter = deps.adapter ?? controllerAdapter(cfg);
    // Asked for inside a model window, the recovery is not run: the claim path
    // would hold it, and a `skipped` would say nothing. It says until when.
    const wait = modelWaitHold(await readModelWait(tasksDir, id), newRunContext().id, modelRoundsOf(cfg), new Date());
    if (wait?.kind === "window") {
      log(`review-only recovery is held by a model window until ${wait.nextAt}; ask again then`);
      return 1;
    }
    // Every other entry point resolves the task's own workdir before reserving
    // and hashing it. Recovery must too, or a task that declares a workdir is
    // re-digested against another tree and refused as changed for good.
    const resolved = { ...cfg, tasksDir, workdir: taskWorkdir(cfg.workdir, task) };
    // Recovery is an entry point like run and watch: it leaves the same
    // per-task event log and the same trailing board refresh.
    const telemetry = await createControllerTelemetry(resolved);
    // The interrupt source, created after the window check above — a recovery
    // held by a window creates nothing, not even the stop source.
    const stop = await createControllerStop(resolved, deps, log, err);
    let outcome: Awaited<ReturnType<typeof runTask>>;
    // Why a `skipped` came back with nothing claimed: a pending stop, or a
    // claim another live owner holds. The two are not the same report.
    let skippedFor: "stop" | "claim" | undefined;
    try {
      outcome = await runTask(resolved, createWorkerDeps({
        deps, adapter, store, telemetry, log, stop: stop.now,
        // The recovery counts an unconfirmed interruption exactly as `run` does.
        observe: (evt) => stop.observe(evt),
      }),
        task, `review-only-${process.pid}-${id}`, { reviewOnly: true, onSkipped: (cause) => { skippedFor = cause; } });
    } finally {
      await stop.close();
      await telemetry.flush();
    }
    if (outcome === "stopped") {
      log(`review-only recovery stopped by the operator: ${id} is blocked again; the parked review is kept`);
      return stop.exitCode() ?? 0;
    }
    if (outcome === "skipped" && stop.now.isRequested()) {
      // Only a stop that landed before the claim is the operator's own report.
      // A claim lost to another owner, or an ownership generation that changed
      // under the attempt, is the ordinary refusal — said beside the stop, and
      // exiting 1, never answered with the stop's own code.
      stop.report("scheduler", log);
      if (skippedFor !== "stop") {
        log("review-only recovery refused or still unavailable: skipped");
        return 1;
      }
      return stop.exitCode() ?? 0;
    }
    if (outcome === "blocked" && stop.now.isRequested()) {
      // `exitCode` answers 1 exactly for an interruption that could not be
      // confirmed; any other block is a reason of the controller's own (say,
      // no valid parked review) and is reported as the ordinary refusal.
      const unconfirmed = stop.exitCode() === 1;
      stop.report("scheduler", log);
      if (!unconfirmed) log(`review-only recovery refused or still unavailable: ${outcome}`);
      return 1;
    }
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
  "modelRounds",
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
  "workerContext",
  "fixedSources",
  "memory",
  "allowedProviders",
  "allowedModels",
  "allowPaidModels",
  "maxCostPerMillion",
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
    modelRounds: integer(raw, "modelRounds", path),
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
    workerContext: workerContextSwitches(raw.workerContext, path),
    fixedSources: fixedSourcePaths(raw, path),
    memory: memorySettings(raw.memory, path),
    // The budget guard's policy. Each is absent by default; what each one allows is in `src/budget.ts`.
    allowedProviders: stringArray(raw, "allowedProviders", path),
    allowedModels: stringArray(raw, "allowedModels", path),
    allowPaidModels: boolean(raw, "allowPaidModels", path),
    maxCostPerMillion: nonNegativeNumber(raw, "maxCostPerMillion", path),
  };
}

/**
 * The `workerContext` block of `taskctl.json`. Absent stays `undefined`, so
 * the worker's own default applies (both on); an object fills each switch it
 * leaves out with `true`. Anything else is a config error, never a silent
 * default: `"spec": "false"` meant to turn the spec off.
 */
function workerContextSwitches(raw: unknown, path: string): WorkerConfig["workerContext"] {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config ${path}: field "workerContext" must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "spec" && key !== "preferences") {
      throw new Error(`config ${path}: unknown workerContext field "${key}"`);
    }
  }
  const spec = record.spec === undefined ? true : record.spec;
  if (typeof spec !== "boolean") {
    throw new Error(`config ${path}: workerContext.spec must be a boolean`);
  }
  const preferences = record.preferences === undefined ? true : record.preferences;
  if (typeof preferences !== "boolean") {
    throw new Error(`config ${path}: workerContext.preferences must be a boolean`);
  }
  return { spec, preferences };
}

/**
 * The `fixedSources` list of `taskctl.json`: files the worker is given as
 * they stand. Absent stays `undefined`, so nothing is read; an empty list is
 * off too. Each path is made absolute the way `tasksDir` is, since the
 * worker's cwd is its workdir and a relative path would point elsewhere
 * there. `~` is not expanded, and a file need not exist: whether a source can
 * be read is settled when it is read, per attempt, not by refusing the whole
 * configuration.
 */
function fixedSourcePaths(raw: Record<string, unknown>, path: string): string[] | undefined {
  const sources = stringArray(raw, "fixedSources", path);
  return sources === undefined ? undefined : sources.map((source) => resolve(source));
}

/** The settings a `memory` block of `taskctl.json` may carry. */
const MEMORY_KEYS = new Set(["backend", "command", "wing", "excludeWings", "rooms", "minSimilarity", "maxItems", "maxChars", "itemChars", "timeoutMs"]);

/**
 * The `memory` block of `taskctl.json`. Absent stays `undefined`, so memory
 * is off; an object fills each setting it leaves out with its default, the
 * backend included — `none`, so memory stays off until a backend is named.
 * Anything else is a config error, never a silent default, and every message
 * names the block: `memory` is optional, and a typo in it must not quietly
 * turn recall off or change what it keeps.
 */
function memorySettings(raw: unknown, path: string): WorkerConfig["memory"] {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config ${path}: field "memory" must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!MEMORY_KEYS.has(key)) {
      throw new Error(`config ${path}: unknown memory field "${key}"`);
    }
  }
  /** Refuse a setting that is not what it must be; the message names it. */
  function refuse(key: string, must: string): never {
    throw new Error(`config ${path}: memory.${key} must be ${must}`);
  }
  const stringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

  // A setting left out is its default. `null` is a value, and is refused like any other wrong one.
  const backend = record.backend === undefined ? "none" : record.backend;
  if (backend !== "none" && backend !== "mempalace") refuse("backend", '"none" or "mempalace"');
  const command = record.command === undefined ? ["mempalace-mcp"] : record.command;
  if (!stringList(command) || command.length === 0) refuse("command", "a non-empty array of non-empty strings");
  const wing = record.wing;
  if (wing !== undefined && (typeof wing !== "string" || wing.length === 0)) refuse("wing", "a non-empty string");
  const excludeWings = record.excludeWings === undefined ? [] : record.excludeWings;
  if (!stringList(excludeWings)) refuse("excludeWings", "an array of non-empty strings");
  const rooms = record.rooms === undefined ? ["pitfall", "pattern", "decision"] : record.rooms;
  // Not empty: with no room allowed, every hit is filtered out and recall would answer "no hits" forever without saying why.
  if (!stringList(rooms) || rooms.length === 0) refuse("rooms", "a non-empty array of non-empty strings");
  // Its own check: `number` insists on a positive value, and 0 is a setting here — keep everything.
  const minSimilarity = record.minSimilarity === undefined ? 0.55 : record.minSimilarity;
  if (typeof minSimilarity !== "number" || !(minSimilarity >= 0 && minSimilarity <= 1)) refuse("minSimilarity", "a number from 0 to 1");
  const maxItems = record.maxItems === undefined ? 5 : record.maxItems;
  if (!positive(maxItems) || !Number.isInteger(maxItems)) refuse("maxItems", "a positive integer");
  const maxChars = record.maxChars === undefined ? 2_000 : record.maxChars;
  if (!positive(maxChars) || !Number.isInteger(maxChars)) refuse("maxChars", "a positive integer");
  const itemChars = record.itemChars === undefined ? 400 : record.itemChars;
  if (!positive(itemChars) || !Number.isInteger(itemChars)) refuse("itemChars", "a positive integer");
  const timeoutMs = record.timeoutMs === undefined ? 20_000 : record.timeoutMs;
  if (!positive(timeoutMs)) refuse("timeoutMs", "a positive finite number");
  return {
    backend, command: [...command], ...(wing === undefined ? {} : { wing }),
    excludeWings: [...excludeWings], rooms: [...rooms],
    minSimilarity, maxItems, maxChars, itemChars, timeoutMs,
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

/** A switch: `true` or `false`, and nothing else. Absent stays absent, so the default applies. */
function boolean(raw: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`config ${path}: field "${key}" must be a boolean`);
  }
  return value;
}

/**
 * A price cap whose zero is a setting (nothing may cost anything) rather than
 * an omission, such as `maxCostPerMillion`. `number` insists on a positive
 * value, so zero is read here before that rule applies.
 */
function nonNegativeNumber(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`config ${path}: field "${key}" must be a non-negative finite number`);
  }
  return value;
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
