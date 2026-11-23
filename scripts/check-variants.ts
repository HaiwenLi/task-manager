// Live check against the real opencode CLI: which chain models publish the
// `high` variant, and what string would actually be dispatched.
//
//   npx tsx scripts/check-variants.ts [opencode-bin]
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

const adapter = new OpenCodeAdapter({
  bin: process.argv[2] ?? "opencode",
});

const chain = [
  "minimax-cn-coding-plan/MiniMax-M3.1-Flash",
  "kimi-code-plan-cn/kimi-for-coding",
  "zhipuai-coding-plan/glm-5.3",
  "deepseek/deepseek-flash",
];

for (const model of chain) {
  const resolved = await adapter.resolveModel(model, "high");
  console.log(`${model}\n  -> ${resolved}`);
}
