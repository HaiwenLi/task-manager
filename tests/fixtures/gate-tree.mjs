import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A gate that looks like the owner's: a root command starts a child, which
// starts a grandchild. All three inherit the output pipes and all run until
// they are killed. The leaf records the three pids so a test can check the
// tree it stopped.
const self = fileURLToPath(import.meta.url);
const role = process.argv[2] ?? "root";
const [rootArg, childArg] = process.argv.slice(3);
if (role === "root") {
  spawn(process.execPath, [self, "child", String(process.pid)], { stdio: "inherit" });
} else if (role === "child") {
  spawn(process.execPath, [self, "leaf", rootArg, String(process.pid)], { stdio: "inherit" });
} else {
  writeFileSync("tree-pids.json", JSON.stringify({ root: Number(rootArg), child: Number(childArg), leaf: process.pid }));
}
setInterval(() => {}, 1_000);
