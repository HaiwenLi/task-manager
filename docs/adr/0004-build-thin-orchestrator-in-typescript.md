# 自建薄编排器，TypeScript / Node 实现

调研最接近的 rove（75/100）仍缺自动认领循环、每 Task model/effort、Session 链三块——恰是本项目核心。决定从零自建薄编排器，按需借鉴模式与模块（均 MIT）：NEEDLE 的原子认领语义、ordewell 的任务数据模型与"done 工具上报"、rove 的引擎注册思路。语言用 TypeScript + Node 22 LTS。
_否决_：fork rove（在其 kanban/worktree 模型里修宪，成本高于自建小核心）；Go/Rust（`@opencode/client`、`@moonshot-ai/kimi-code-sdk` 等官方 SDK 全是 npm 包，换语言徒手重写 HTTP 层零增益）。

## Consequences

- 自有核心约四模块：任务存储 / 认领循环 / Adapter / 任务协议
- rove 具体模块（如进程管理）若日后值得抄，MIT 许可允许直接搬
