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
};

/** Shown instead of a handoff note when the task is on its first session. */
const FIRST_SESSION_PLACEHOLDER = "（这是本任务第一个会话，无前序笔记）";

/**
 * Assemble the task protocol injected into every worker session (ADR-0006):
 * the task itself, the work rules (workdir discipline, `taskctl done`/`note`
 * usage with an absolute `--tasks-dir`, the HANDOFF_READY contract), and the
 * previous session's handoff note. The copy is spec-fixed — every worker
 * shares one protocol, so changing it is a spec change, not a refactor.
 * Pure string templating: no I/O, values are inserted verbatim.
 */
export function buildWorkerPrompt(task: Task, ctx: WorkerPromptContext): string {
  const handoff = ctx.handoff ?? FIRST_SESSION_PLACEHOLDER;
  return `# 任务：${task.title}

${task.description}

## 工作规则
- 工作目录：${ctx.workdir}；只在此目录内改动
- 完成全部要求后，运行：taskctl done --task ${task.id} --tasks-dir "${ctx.tasksDir}"
- 阶段性发现请随时运行：taskctl note --task ${task.id} --tasks-dir "${ctx.tasksDir}" --status <一句话状态> --done <已完成> --found <关键发现> --next <下一步> --files <逗号分隔文件>
- 若收到"上下文预算告急"的收尾指令：立即运行一次 taskctl note（尽量详尽，同上参数），然后只回复 HANDOFF_READY

## 上一段会话的交接笔记
${handoff}
`;
}
