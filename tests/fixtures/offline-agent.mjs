import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "artifact.txt"), "fixture output");
writeFileSync(process.env.TASKCTL_FIXTURE_MARKER, "requested");
console.log(JSON.stringify({ type: "text", sessionID: "offline-session", text: "fixture completed" }));
appendFileSync(join(process.cwd(), "starts.txt"), "started\n");
if (process.env.TASKCTL_FIXTURE_EXIT === "1") process.kill(process.pid, "SIGTERM");
if (process.env.TASKCTL_FIXTURE_HANG === "1") setInterval(() => {}, 1000);
