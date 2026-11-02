import { runCli } from "./cli.js";

// bin 入口（package.json "bin" → dist/main.js）。runCli 自行捕获一切错误：
// 用法错误 exit 2、运行错误 exit 1，这里只把结果交给 exitCode。
process.exitCode = await runCli(process.argv.slice(2));
