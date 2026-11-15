import { readdir } from "node:fs/promises";

/** The four kinds of work taskctl is expected to carry; each gets its own intake template. */
export type TaskType = "code" | "office" | "research" | "design";

/**
 * The three buckets of an intake template:
 * - `required`: only the user knows this, and guessing wrong is expensive.
 * - `infer`: the agent drafts it from the repo/history/profile; the user deletes.
 * - `ask`: asked only when it changes acceptance, at most three at a time.
 */
export type IntakeTemplate = { required: string[]; infer: string[]; ask: string[] };

export const TEMPLATES: Record<TaskType, IntakeTemplate> = {
  code: {
    required: ["改动后是什么样（一句话，可观察）", "不许动的东西", "怎么算完成（能跑的命令或看得见的现象）", "额度或截止（没有就写无）"],
    infer: ["要改哪些文件或目录", "技术路线与依赖", "验收命令（从仓库现有脚本推）", "既有约定与风格"],
    ask: ["这个改动会不会影响线上正在用的接口", "有没有必须保持兼容的旧行为", "要不要顺带补测试"],
  },
  office: {
    required: ["交付物是什么、给谁看", "必须包含的内容与必须不包含的内容", "篇幅、格式或模板要求", "截止时间"],
    infer: ["可引用的现有材料", "用词与语气（从偏好档案推）", "排版结构", "需要核对的数据来源"],
    ask: ["是否需要引用数字或来源", "有没有既定的模板或上一版可参考"],
  },
  research: {
    required: ["要回答的问题（一句话）", "判定结论是否成立的依据", "覆盖范围与明确不覆盖的范围", "时间或篇幅上限"],
    infer: ["可靠信息源清单", "已知结论与争议点", "输出结构", "需要交叉验证的关键数字"],
    ask: ["结论要给谁做决策用", "对时效性有没有要求"],
  },
  design: {
    required: ["要设计的是什么、给谁看", "必须传达的信息或情绪", "硬约束（尺寸、品牌色、必须出现的元素）", "截止时间"],
    infer: ["参考风格", "可用的素材与字体", "版式与信息层级", "历史同类稿件的做法"],
    ask: ["有没有必须沿用或必须避开的既有样式", "最终交付格式"],
  },
};

/**
 * Explicit statements only. A downgrade skips the signature gate, so a miss is
 * expensive: negations ("不是简单任务") and mentions ("上次那个简单任务") must not
 * count, and only "是/算…简单任务" or a leading `simple:`/`简单任务：` does.
 */
export function detectComplexity(intent: string): "simple" | "complex" {
  const text = intent.trim();
  if (/不是\s*(?:一个|个)?\s*简单任务|不算\s*(?:一个|个)?\s*简单任务/.test(text)) return "complex";
  if (/^(?:简单任务|simple\s*:)/i.test(text)) return "simple";
  if (/(?:这|那)?(?:是|算)(?:一个|个)?\s*简单任务/.test(text)) return "simple";
  return "complex";
}

/** Keyword routing; anything unrecognised is treated as code. */
export function detectType(intent: string): TaskType {
  if (/调研|研究|分析|综述|对比|评估/i.test(intent)) return "research";
  if (/设计|视觉|排版|ppt|幻灯|海报|封面|图标/i.test(intent)) return "design";
  if (/文档|表格|报告|邮件|周报|excel|word|汇报/i.test(intent)) return "office";
  return "code";
}

/**
 * Next free id: the highest numeric prefix plus one, padded to three digits,
 * plus an ASCII slug. A Chinese-only title has no usable slug, so it becomes
 * `task`; the numeric prefix is what keeps ids unique and sortable.
 */
export async function nextTaskId(tasksDir: string, title: string): Promise<string> {
  let highest = 0;
  try {
    for (const name of await readdir(tasksDir)) {
      const match = /^(\d+)-.*\.md$/.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "task";
  return `${String(highest + 1).padStart(3, "0")}-${slug}`;
}

/**
 * The clarify prompt. It carries the template, the user's own words, and the
 * rules that keep the draft honest: infer instead of asking, at most three
 * questions, and never dress an unfalsifiable wish as a checkable criterion.
 */
export function buildClarifyPrompt(args: { task: { title: string; description: string }; type: TaskType; profile: string | null }): string {
  const template = TEMPLATES[args.type];
  const lines = [
    "你是任务澄清助手。用户给了一段定性的意图，你要把它变成可执行的 spec。",
    "",
    "## 用户的意图（原文，不要改写）",
    args.task.description.trim(),
    "",
    `## 任务类型：${args.type}`,
    "",
    "## 必答（只有用户知道，猜错代价大；缺了就问，不要编）",
    ...template.required.map((item) => `- ${item}`),
    "",
    "## 可推（你自己从仓库、历史任务、偏好档案里推，写进 spec 让用户删）",
    ...template.infer.map((item) => `- ${item}`),
    "",
    "## 补问（最多 3 条，只问会改变验收的空白；没有就一条都不问）",
    ...template.ask.map((item) => `- ${item}`),
    "",
    "## 硬规则",
    "1. 能推的不要问。用户的删除成本远低于回答一个开放问题。",
    "2. 补问最多 3 条，一次问完，不要来回追问。",
    "3. 不许把无法判定的东西写成可判定：每条验收标准必须能落到命令退出码、可观察产物或可引用事实。",
    "4. 验收标准以 C1、C2 编号，一条一行。",
    "5. 不要输出讨论过程、客套话或多个方案对比；只输出下面这份 spec。",
    "",
    "## 模糊表述",
    "把意图里含糊的词（差不多、尽量、大概、尽快、好看）摘出来，给出你的解释和影响面。判断标准：能落成命令或可观察现象才算消歧完成。",
    "",
    "## 输出格式（严格照抄二级标题，不要加别的章节）",
    "## 目标",
    "## 非目标",
    "## 验收标准",
    "- C1 …",
    "## 边界",
    "## 假设",
    "## 模糊表述",
  ];
  if (args.profile !== null) {
    lines.push("", "## 用户偏好档案（来自过往确认与纠错，优先遵守）", args.profile.trim());
  }
  return lines.join("\n");
}
