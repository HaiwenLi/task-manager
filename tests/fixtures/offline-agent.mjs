import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Used as an opencode stand-in. A control-plane call is not an agent run: the
// adapter asks the service to stop the session when a turn is cancelled, and
// this fixture is no service - answering would drop the fixture files into
// whatever directory the test runner happens to run in.
if (process.argv[2] === "api") process.exit(2);

writeFileSync(join(process.cwd(), "artifact.txt"), "fixture output");
writeFileSync(process.env.TASKCTL_FIXTURE_MARKER, "requested");
console.log(JSON.stringify({ type: "text", sessionID: "offline-session", text: "fixture completed" }));
appendFileSync(join(process.cwd(), "starts.txt"), "started\n");
if (process.env.TASKCTL_FIXTURE_EXIT === "1") process.kill(process.pid, "SIGTERM");
if (process.env.TASKCTL_FIXTURE_HANG === "1") setInterval(() => {}, 1000);
