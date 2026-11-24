import type { Task } from "./task-file.js";

/**
 * What the orchestrator resolves before assembling the prompt. Every path is
 * absolute: the worker's cwd is {@link WorkerPromptContext.workdir}, so a
 * relative `--tasks-dir` would point at the wrong directory.
 */
export type WorkerPromptContext = {
  /** Markdown of the previous session's handoff note; absent on the first session. */
  handoff?: string;
  /** Absolute path of the task's working directory. */
  workdir: string;
  /** Absolute path of the tasks directory the worker's `taskctl` calls target. */
  tasksDir: string;
  /** Absolute path of this task's own directory (= `$TASKCTL_TASK_DIR`). */
  taskDir: string;
  /** Absolute path the worker must write logs and temp files to (= `$TASKCTL_LOG_DIR`). */
  logDir: string;
};

/** Shown instead of a handoff note when the task is on its first session. */
const FIRST_SESSION_PLACEHOLDER = "（这是本任务第一个会话，无前序笔记）";

/**
 * Assemble the task protocol injected into every worker session (ADR-0006):
 * the task itself, the work rules (workdir discipline, the LOG_DIR rule for
 * temp files and logs, `taskctl done`/`note` usage with an absolute
 * `--tasks-dir`, the HANDOFF_READY contract), and the previous session's
 * handoff note. The copy is spec-fixed — every worker shares one protocol,
 * so changing it is a spec change, not a refactor.
 * Pure string templating: no I/O, values are inserted verbatim.
 */
export function buildWorkerPrompt(task: Task, ctx: WorkerPromptContext): string {
  const handoff = ctx.handoff ?? FIRST_SESSION_PLACEHOLDER;
  return `# 任务：${task.title}

${task.description}

## 工作规则
- 工作目录：${ctx.workdir}；只在此目录内改动
- 临时文件与日志一律写 ${ctx.logDir}（环境变量 $TASKCTL_LOG_DIR）；工作目录根目录只放交付物
- 完成全部要求后，运行：taskctl done --task ${task.id} --tasks-dir "${ctx.tasksDir}"
- 阶段性发现请随时运行：taskctl note --task ${task.id} --tasks-dir "${ctx.tasksDir}" --status <一句话状态> --done <已完成> --found <关键发现> --next <下一步> --files <逗号分隔文件>
- acceptance 全量验收由控制器在 done 后运行；不要自行重复运行。自验只跑有界的定向检查
- 若任务声明了 worker_self_check，用 taskctl check --task ${task.id} --tasks-dir "${ctx.tasksDir}" 执行，不要用 shell 绕过超时
- 若任务实际比声明更复杂，单独输出一行 ESCALATE: <原因>；只能升级管理强度，不能自行降低验收标准
- 若收到"上下文预算告急"的收尾指令：立即运行一次 taskctl note（尽量详尽，同上参数），然后只回复 HANDOFF_READY

## 上一段会话的交接笔记
${handoff}
`;
}
