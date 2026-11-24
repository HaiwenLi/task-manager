import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definitionDigest, readRuntime, writeRuntime } from "./runtime.js";
import { extractJson } from "./review.js";
import { assertAcyclic } from "./scheduler.js";
import { TaskStore } from "./task-store.js";
import { serializeTaskFile, type DriftKind, type Task, type TaskExecution, type TaskVerify } from "./task-file.js";

/**
 * Raised when a split plan cannot be made, read or published. Every refusal
 * happens before anything is written, so a rejected plan never leaves a
 * half-published bundle behind.
 */
export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

export const SPLIT_PLAN_SCHEMA = "taskctl/split-plan/v1";

/** A split with one child is not a split; more than this is a project, not a task. */
export const MAX_SPLIT_CHILDREN = 12;

/** One child as planned. Everything needed to write its task file is here. */
export type SplitChild = {
  id: string;
  title: string;
  body: string;
  criteria: string[];
  acceptance?: string;
  verify: TaskVerify;
  renderTargets: string[];
  execution: TaskExecution;
  dependsOn: string[];
};

/** What every child takes from its parent. A plan may not lower any of it. */
export type SplitInherited = {
  risk: Task["risk"];
  humanCheck: boolean;
  tolerate: DriftKind[];
  keepAtRoot: string[];
  workdir?: string;
  model?: string;
  effort?: string;
};

/**
 * `tasks/<id>/split-plan.json`. It is the whole split, written down: applying
 * it touches no model, so what a person reads here is exactly what lands on
 * the board — and the same file resumes publication after a crash.
 */
export type SplitPlan = {
  schema: typeof SPLIT_PLAN_SCHEMA;
  parentId: string;
  /** Digest of the parent definition the plan was made against. */
  parentDigest: string;
  createdAt: string;
  model: string;
  inherited: SplitInherited;
  children: SplitChild[];
  /** What the parent does once every child is done. */
  integration: { instructions: string; criteria: string[] };
};

export type SplitContext = { parent: Task; spec: string; board: Task[]; model: string; now: Date };

export type SplitApplyResult = { written: string[]; alreadyPresent: string[]; parentLinked: boolean };

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ID_PATTERN = /^[0-9]+-[a-z0-9][a-z0-9-]*$/;
const VERIFIES: readonly TaskVerify[] = ["human", "mechanical", "render"];
const EXECUTIONS: readonly TaskExecution[] = ["continuous", "iterative"];
const TITLE_LIMIT = 120;
const BODY_LIMIT = 20_000;
const INSTRUCTION_LIMIT = 4_000;
const CRITERION_PREFIX = /^\s*C\d+\s*[.、:：-]?\s*/i;
const INTEGRATION_HEADING = "## 拆分与整合（taskctl split）";

/**
 * The planner's brief. The model refers to children by a short `key`; taskctl
 * turns keys into real ids, so the model can neither invent ids nor collide
 * with a task that already exists.
 */
export function buildSplitPrompt(args: { parent: Task; spec: string }): string {
  const { parent, spec } = args;
  return [
    "你是任务拆分规划器。把下面这个复杂任务拆成若干可以独立验收的子任务，并写清父任务最后如何整合它们。",
    "只输出一个 JSON 对象，不要解释，不要用代码块包裹。",
    "",
    "## 父任务",
    `id：${parent.id}`,
    `标题：${parent.title}`,
    "意图（原文）：",
    parent.description.trim(),
    "",
    "## spec",
    spec.trim() || "（没有 spec）",
    "",
    "## 最终验收标准（父任务的；整合后必须整体成立，不得改写或删除）",
    ...parent.criteria.map((criterion) => `- ${criterion}`),
    ...(parent.acceptance === undefined ? [] : ["", `父任务验收命令：${parent.acceptance}`]),
    "",
    "## 规则",
    `1. 子任务数量在 2 到 ${MAX_SPLIT_CHILDREN} 之间。每个子任务必须能独立验收：至少一条可判定的验收标准（能落到命令退出码、可观察产物或可引用事实），并有写给执行者的完整说明（做什么、改哪里、约束）。`,
    "2. 每个子任务有一个 key：1–24 个字符，只用小写字母、数字和连字符，互不重复。子任务之间的先后只用 dependsOn 表达，里面填其他子任务的 key；不得成环，不得填自己，不得引用不存在的 key。",
    "3. 子任务合起来必须覆盖父任务的意图和全部最终验收标准。父任务的最终验收标准必须原样出现在 integration.criteria 里；可以追加整合才需要的条目，编号接着往后排。",
    `4. verify 只有在子任务确实能被客观判定时才用 mechanical（必须同时给出 acceptance 命令）或 render（必须同时给出 renderTargets）；拿不准就用 human。父任务是 risk: ${parent.risk}${parent.humanCheck ? "、human_check: true" : ""}，子任务会原样继承，规划不能降低。`,
    "5. execution：一个 worker 回合能做完的用 continuous；需要带着验收或复核的反馈返工的用 iterative。",
    "6. 不要把「讨论方案」「写计划」这类无法验收的步骤单列成子任务；把它们并进第一个可交付的子任务。",
    "7. integration.instructions 写父任务在所有子任务完成后要做的整合与联调，不要重复子任务的内容。",
    "",
    "JSON 形状：",
    `{"children":[{"key":"api","title":"…","body":"…","criteria":["C1 …"],"acceptance":"<shell 命令，可省略>","verify":"human|mechanical|render","renderTargets":["a.html"],"execution":"continuous|iterative","dependsOn":["<其他子任务的 key>"]}],"integration":{"instructions":"…","criteria":["C1 …","C2 …"]}}`,
  ].join("\n");
}

/**
 * Turn the planner's answer into a plan. Conversion is lenient — a missing
 * title becomes an empty one, not an exception — and {@link validateSplitPlan}
 * is the single place that says what a plan must satisfy, so a hand-edited
 * plan file is judged by exactly the rules a fresh one is.
 */
export function parseSplitPlan(text: string, context: SplitContext): SplitPlan {
  const parsed = extractJson(text);
  if (parsed === null || !Array.isArray(parsed.children)) {
    throw new SplitError("the planner output was not a JSON object with a children array");
  }
  if (context.parent.parentId !== undefined) {
    throw new SplitError(`task ${context.parent.id} is itself a split child; a nested split is not supported`);
  }
  const keys = parsed.children.map((raw, index) => keyOf(raw, index));
  if (new Set(keys).size !== keys.length) {
    throw new SplitError(`duplicate child key "${keys.find((key, index) => keys.indexOf(key) !== index)}": each child needs its own`);
  }
  const ids = allocateChildIds(context.parent.id, keys, context.board);
  const byKey = new Map(keys.map((key, index) => [key, ids[index]!]));
  const plan: SplitPlan = {
    schema: SPLIT_PLAN_SCHEMA,
    parentId: context.parent.id,
    parentDigest: definitionDigest(context.parent),
    createdAt: context.now.toISOString(),
    model: context.model,
    inherited: inheritedFrom(context.parent),
    children: parsed.children.map((raw) => childFrom(raw, byKey)),
    integration: integrationFrom(parsed.integration, context.parent.criteria),
  };
  validateSplitPlan(plan);
  return plan;
}

/** The plan of one task, or `null` when it has none. An unreadable plan is an error, never "none". */
export async function readSplitPlan(tasksDir: string, id: string): Promise<SplitPlan | null> {
  let parsed: unknown;
  try {
    parsed = await readRuntime<unknown>(tasksDir, id, "split-plan.json");
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new SplitError(`the split plan of task ${id} is unreadable (not valid JSON): repair or delete ${splitPlanPath(tasksDir, id)} by hand`);
    }
    throw err;
  }
  if (parsed === null) return null;
  try {
    validateSplitPlan(parsed as SplitPlan);
  } catch (err) {
    if (err instanceof SplitError) {
      throw new SplitError(`the split plan of task ${id} is not valid: ${err.message}`);
    }
    throw err;
  }
  return parsed as SplitPlan;
}

/** Write the plan atomically. What is written is what was validated. */
export async function writeSplitPlan(tasksDir: string, plan: SplitPlan): Promise<string> {
  validateSplitPlan(plan);
  // A hand-written draft parent may be a bare file with no directory yet.
  await mkdir(join(tasksDir, plan.parentId), { recursive: true });
  await writeRuntime(tasksDir, plan.parentId, "split-plan.json", plan);
  return splitPlanPath(tasksDir, plan.parentId);
}

export function splitPlanPath(tasksDir: string, id: string): string {
  return join(tasksDir, id, "split-plan.json");
}

/** Identifies one plan content, so "the bundle linked to this plan" is checkable. */
export function planDigest(plan: SplitPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

/**
 * Child ids continue the board's numeric sequence, prefixed with the parent's
 * slug so a directory listing keeps a bundle together. Allocation happens once,
 * at planning time, and the result is stored in the plan: resuming publication
 * after a crash reuses it instead of spending new ids.
 *
 * By construction a new id cannot collide: it is numbered past the highest
 * number already on the board. An id that exists by the time the plan is
 * applied is caught there, where it can be told apart from a matching child.
 */
export function allocateChildIds(parentId: string, keys: string[], board: Task[]): string[] {
  let highest = 0;
  for (const task of board) {
    const match = /^(\d+)-/.exec(task.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const slug = parentId.toLowerCase().replace(/^[0-9]+-/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
  return keys.map((key, index) => `${String(highest + index + 1).padStart(3, "0")}-${slug}-${key}`);
}

/**
 * Everything a plan must satisfy, in one place, for a fresh plan and for one
 * read back from disk. Kept deliberately dumb: each rule is a statement about
 * the plan alone, so it can be checked without the board or the model.
 */
export function validateSplitPlan(plan: SplitPlan): void {
  if (typeof plan !== "object" || plan === null) throw new SplitError("split plan is not an object");
  if (plan.schema !== SPLIT_PLAN_SCHEMA) throw new SplitError(`split plan schema is ${String(plan.schema)}, expected ${SPLIT_PLAN_SCHEMA}`);
  if (typeof plan.parentId !== "string" || plan.parentId.length === 0) throw new SplitError("split plan has no parent id");
  if (!/^[a-f0-9]{64}$/.test(plan.parentDigest)) throw new SplitError("split plan has no valid parent digest");
  const children: unknown[] = Array.isArray(plan.children) ? plan.children : [];
  if (children.some((child) => typeof child !== "object" || child === null)) {
    throw new SplitError("a child of the plan is not an object");
  }
  if (children.length < 2) throw new SplitError(`a split needs at least two children; the plan has ${children.length}`);
  if (children.length > MAX_SPLIT_CHILDREN) throw new SplitError(`a split may have at most ${MAX_SPLIT_CHILDREN} children; the plan has ${children.length}`);

  const ids = children.map((child) => (child as SplitChild | null)?.id as string);
  if (new Set(ids).size !== ids.length) throw new SplitError("split plan has duplicate child ids");
  if (ids.includes(plan.parentId)) throw new SplitError("a child id must differ from the parent id");
  const byId = new Map(children.map((child) => [(child as SplitChild).id, child as SplitChild]));

  for (const child of children as SplitChild[]) {
    const who = `child ${child.id}`;
    if (typeof child.id !== "string" || !ID_PATTERN.test(child.id)) throw new SplitError(`${who}: "${String(child.id)}" is not a valid task id`);
    if (!hasText(child.title)) throw new SplitError(`${who} needs a title`);
    if (child.title.length > TITLE_LIMIT) throw new SplitError(`${who}: title is longer than ${TITLE_LIMIT} characters`);
    if (!hasText(child.body)) throw new SplitError(`${who} needs a body`);
    if (child.body.length > BODY_LIMIT) throw new SplitError(`${who}: body is longer than ${BODY_LIMIT} characters`);
    if (!Array.isArray(child.criteria) || child.criteria.length === 0 || child.criteria.some((criterion) => !hasText(criterion))) {
      throw new SplitError(`${who} needs at least one acceptance criterion`);
    }
    if (!VERIFIES.includes(child.verify)) throw new SplitError(`${who}: verify must be one of ${VERIFIES.join(", ")}`);
    if (child.verify === "mechanical" && !hasText(child.acceptance)) throw new SplitError(`${who}: verify mechanical needs an acceptance command`);
    if (child.verify === "render" && (child.renderTargets?.length ?? 0) === 0) {
      throw new SplitError(`${who}: verify render needs at least one render target`);
    }
    if (!EXECUTIONS.includes(child.execution)) throw new SplitError(`${who}: execution must be one of ${EXECUTIONS.join(", ")}`);
    for (const dependency of child.dependsOn ?? []) {
      if (dependency === child.id) throw new SplitError(`${who} depends on itself`);
      if (!byId.has(dependency)) throw new SplitError(`${who} depends on ${dependency}, which is not a child of this plan`);
    }
  }

  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new SplitError(`dependency cycle among children: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...path, id]);
    state.set(id, "done");
  };
  for (const child of children as SplitChild[]) visit(child.id, []);

  const integration = plan.integration;
  if (typeof integration !== "object" || integration === null) throw new SplitError("the plan needs an integration section");
  if (!hasText(integration.instructions)) throw new SplitError("the plan needs an integration step: integration.instructions is empty");
  if (integration.instructions.length > INSTRUCTION_LIMIT) throw new SplitError(`the integration step is longer than ${INSTRUCTION_LIMIT} characters`);
  if (!Array.isArray(integration.criteria) || integration.criteria.length === 0 || integration.criteria.some((criterion) => !hasText(criterion))) {
    throw new SplitError("the plan needs the final criteria the parent is judged by");
  }
}

/** The plan as a person reads it before signing the bundle. */
export function renderSplitPlan(plan: SplitPlan): string[] {
  const lines = [
    `parent  ${plan.parentId} · planned against definition ${plan.parentDigest.slice(0, 12)} · ${plan.createdAt}`,
    `children ${plan.children.length}`,
  ];
  for (const child of plan.children) {
    lines.push(`  ${child.id}  ${child.title}`);
    lines.push(`    execution ${child.execution} · verify ${child.verify} · depends_on ${child.dependsOn.length === 0 ? "(none)" : child.dependsOn.join(", ")}`);
    if (child.acceptance !== undefined) lines.push(`    acceptance ${child.acceptance}`);
    for (const criterion of child.criteria) lines.push(`    ${criterion}`);
  }
  lines.push("integration", `  ${plan.integration.instructions.replace(/\s*\r?\n\s*/g, " ")}`, "final criteria (the parent keeps its own)");
  for (const criterion of plan.integration.criteria) lines.push(`  ${criterion}`);
  return lines;
}

/**
 * Publish a plan: gated child files first, the parent link last.
 *
 * Order is the whole safety argument. Children are `open` but cannot run while
 * an ancestor is `draft`, so a crash after step 2 leaves them harmlessly held;
 * a crash after step 4 is a no-op to resume. Nothing is written until every
 * refusal has been decided, so a rejected apply never leaves part of a bundle.
 *
 * `beforeParentLink` is the point between "children written" and "parent
 * linked" — the one place a crash leaves visible, resumable work — exposed so
 * a test can interrupt exactly there.
 */
export async function applySplitPlan(
  tasksDir: string,
  plan: SplitPlan,
  options: { beforeParentLink?: () => Promise<void> } = {},
): Promise<SplitApplyResult> {
  validateSplitPlan(plan);
  const store = new TaskStore(tasksDir);
  const id = plan.parentId;
  let parent: Task;
  try {
    parent = await store.get(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new SplitError(`task ${id} does not exist`);
    throw err;
  }
  if (parent.status !== "draft") {
    throw new SplitError(`task ${id} is ${parent.status}, expected draft: a split is published while the parent waits for approval`);
  }
  if (parent.parentId !== undefined) {
    throw new SplitError(`task ${id} is itself a split child; a nested split is not supported`);
  }

  const board = await store.list();
  const byId = new Map(board.map((task) => [task.id, task]));
  const digest = planDigest(plan);
  const applied = await readApplied(tasksDir, id);
  const linked = applied !== null && applied.planDigest === digest;
  // An unlinked parent must still be the definition the plan was made against.
  // A linked one has moved on by design — the link is part of its definition.
  if (!linked && definitionDigest(parent) !== plan.parentDigest) {
    throw new SplitError(
      `the definition of task ${id} changed since the plan was made (plan ${plan.parentDigest.slice(0, 12)}, found ${definitionDigest(parent).slice(0, 12)}); `
      + `run taskctl split --task ${id} again to re-plan`,
    );
  }

  const plannedIds = new Set(plan.children.map((child) => child.id));
  for (const task of board) {
    if (task.parentId === id && !plannedIds.has(task.id)) {
      throw new SplitError(`task ${task.id} is a child of ${id} but not in this plan; remove it by hand before applying`);
    }
  }
  for (const child of plan.children) {
    const existing = byId.get(child.id);
    if (existing === undefined) continue;
    if (existing.parentId !== id) {
      throw new SplitError(`task ${child.id} already exists and is not a child of ${id}; nothing was written`);
    }
    // A child that differs was edited, or came from another plan. Which one is
    // a person's judgement, so publication stops for inspection.
    if (definitionDigest(existing) !== definitionDigest(childTaskFromPlan(plan, child))) {
      throw new SplitError(
        `task ${child.id} differs from the plan; nothing was written. `
        + `Inspect it by hand: restore it, or delete it and run --apply again.`,
      );
    }
  }

  const result: SplitApplyResult = { written: [], alreadyPresent: [], parentLinked: linked };
  for (const child of plan.children) {
    if (byId.has(child.id)) {
      result.alreadyPresent.push(child.id);
    } else {
      await writeFile(join(tasksDir, `${child.id}.md`), serializeTaskFile(childTaskFromPlan(plan, child)), { encoding: "utf8", flag: "wx" });
      result.written.push(child.id);
    }
    // Where this child came from, for whoever reads the board later.
    await mkdir(join(tasksDir, child.id), { recursive: true });
    await writeRuntime(tasksDir, child.id, "split.json", { schema: SPLIT_PLAN_SCHEMA, parentId: id, planDigest: digest, planned: child });
  }

  // Re-read what actually landed: the files are the authority, not the plan.
  assertAcyclic(await store.list());

  if (!linked) {
    await options.beforeParentLink?.();
    await linkParent(store, tasksDir, plan, parent);
    result.parentLinked = true;
  }
  return result;
}

async function linkParent(store: TaskStore, tasksDir: string, plan: SplitPlan, parent: Task): Promise<void> {
  const id = plan.parentId;
  const dependsOn = [...parent.dependsOn];
  for (const child of plan.children) {
    if (!dependsOn.includes(child.id)) dependsOn.push(child.id);
  }
  // The parent keeps its own final criteria, then takes what integration adds.
  // They are taken from the parent, not from the plan, so no plan — however
  // edited — can drop one.
  const present = new Set(parent.criteria.map(criterionText));
  const criteria = [...parent.criteria];
  for (const criterion of plan.integration.criteria) {
    const text = criterionText(criterion);
    if (present.has(text)) continue;
    present.add(text);
    criteria.push(`C${criteria.length + 1} ${text}`);
  }
  const linked = await store.updateFields(id, { dependsOn, description: withIntegrationSection(parent.description, plan), criteria });
  await mkdir(join(tasksDir, id), { recursive: true });
  await writeRuntime(tasksDir, id, "split-applied.json", {
    schema: SPLIT_PLAN_SCHEMA, planDigest: planDigest(plan), linkedDigest: definitionDigest(linked), appliedAt: new Date().toISOString(),
  });
}

/** The parent's body with one integration section: appended once, replaced if somehow present. */
function withIntegrationSection(description: string, plan: SplitPlan): string {
  const section = [
    INTEGRATION_HEADING, "",
    "本任务拆成以下子任务，全部 `done` 后由本任务整合：", "",
    ...plan.children.map((child) => `- ${child.id}「${child.title}」`), "",
    "整合要求：", "", plan.integration.instructions.trim(),
  ].join("\n");
  const start = description.indexOf(INTEGRATION_HEADING);
  const head = (start === -1 ? description : description.slice(0, start)).trimEnd();
  return head.length === 0 ? `${section}\n` : `${head}\n\n${section}\n`;
}

/** A child exactly as the plan writes it: `open`, gated by its parent, inheriting what it may not lower. */
function childTaskFromPlan(plan: SplitPlan, child: SplitChild): Task {
  const inherited = plan.inherited;
  return {
    id: child.id,
    title: child.title,
    description: child.body,
    status: "open",
    ...(inherited.model === undefined ? {} : { model: inherited.model }),
    ...(inherited.effort === undefined ? {} : { effort: inherited.effort }),
    ...(child.acceptance === undefined ? {} : { acceptance: child.acceptance }),
    criteria: [...child.criteria],
    complexity: child.execution === "continuous" ? "simple" : "complex",
    execution: child.execution,
    risk: inherited.risk,
    ...(inherited.workdir === undefined ? {} : { workdir: inherited.workdir }),
    keepAtRoot: [...inherited.keepAtRoot],
    dependsOn: [...child.dependsOn],
    parentId: plan.parentId,
    humanCheck: inherited.humanCheck,
    tolerate: [...inherited.tolerate],
    quick: false,
    verify: child.verify,
    renderTargets: [...child.renderTargets],
    reviewRounds: 0,
    sessions: [],
    retries: 0,
  };
}

/** The record that says the parent was linked to one particular plan. */
async function readApplied(tasksDir: string, id: string): Promise<{ planDigest?: unknown } | null> {
  try {
    return await readRuntime<{ planDigest?: unknown }>(tasksDir, id, "split-applied.json");
  } catch (err) {
    // A torn record cannot vouch for anything; the caller then falls back to
    // the digest check, which refuses rather than assumes.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function inheritedFrom(parent: Task): SplitInherited {
  return {
    risk: parent.risk,
    humanCheck: parent.humanCheck,
    tolerate: [...parent.tolerate],
    keepAtRoot: [...parent.keepAtRoot],
    ...(parent.workdir === undefined ? {} : { workdir: parent.workdir }),
    ...(parent.model === undefined ? {} : { model: parent.model }),
    ...(parent.effort === undefined ? {} : { effort: parent.effort }),
  };
}

function keyOf(raw: unknown, index: number): string {
  const key = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).key : undefined;
  if (typeof key !== "string" || !KEY_PATTERN.test(key.trim().toLowerCase())) {
    throw new SplitError(`child ${index + 1} needs a key of 1–24 characters using lowercase letters, digits and hyphens`);
  }
  return key.trim().toLowerCase();
}

/** Lenient conversion; {@link validateSplitPlan} decides whether the result is acceptable. */
function childFrom(raw: unknown, byKey: Map<string, string>): SplitChild {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const key = typeof record.key === "string" ? record.key.trim().toLowerCase() : "";
  const id = byKey.get(key) ?? key;
  return {
    id,
    title: typeof record.title === "string" ? record.title.trim() : "",
    body: typeof record.body === "string" ? record.body.trim() : "",
    criteria: renumber(stringsOf(record.criteria).map((criterion) => criterionText(criterion))),
    ...(hasText(record.acceptance) ? { acceptance: String(record.acceptance).trim() } : {}),
    verify: VERIFIES.find((verify) => verify === record.verify) ?? (record.verify === undefined ? "human" : String(record.verify) as TaskVerify),
    renderTargets: stringsOf(record.renderTargets),
    execution: EXECUTIONS.find((execution) => execution === record.execution) ?? (record.execution === undefined ? "iterative" : String(record.execution) as TaskExecution),
    dependsOn: stringsOf(record.dependsOn).map((dependency) => byKey.get(dependency.toLowerCase()) ?? dependency),
  };
}

/**
 * The integration step, checked against the parent's final criteria. The
 * parent's criteria are its definition; a plan that drops or rewords one is
 * planning a different task.
 */
function integrationFrom(value: unknown, parentCriteria: string[]): SplitPlan["integration"] {
  if (typeof value !== "object" || value === null) throw new SplitError("the plan needs an integration section with instructions and criteria");
  const record = value as Record<string, unknown>;
  const criteria = stringsOf(record.criteria).map((criterion) => criterionText(criterion));
  const kept = new Set(criteria);
  for (const criterion of parentCriteria) {
    if (!kept.has(criterionText(criterion))) {
      throw new SplitError(`every final criterion of the parent must be kept by the plan; missing or altered: ${criterion}`);
    }
  }
  return {
    instructions: typeof record.instructions === "string" ? record.instructions.trim() : "",
    criteria: renumber(criteria),
  };
}

/** `C1 …`, `C2 …` in order, whatever numbering — if any — the text arrived with. */
function renumber(texts: string[]): string[] {
  return texts.map((text, index) => `C${index + 1} ${text}`);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()) : [];
}

function criterionText(criterion: string): string {
  return criterion.replace(CRITERION_PREFIX, "").trim();
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
