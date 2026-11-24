import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Used as an opencode stand-in. A control-plane call is not an agent run: the
// adapter asks the service to stop the session when a turn is cancelled, and
// this fixture is no service - answering would drop the fixture files into
// whatever directory the test runner happens to run in.
// The two calls the budget guard makes before anything is claimed are the
// exception, because without an answer it reads this backend as unreadable
// and refuses every task: each is answered from the command line alone, so
// no fixture file is written and the `run` logic below is never reached.
// Every other `api` call still exits 2.
const [subcommand, operation] = process.argv.slice(2);

if (subcommand === "api") {
  if (operation === "model.list") {
    process.stdout.write(`${JSON.stringify({ data: [{ id: "one", providerID: "w", cost: [{ input: 0, output: 0 }] }] })}\n`);
  } else if (operation === "model.default") {
    process.stdout.write(`${JSON.stringify({ location: { directory: "." }, data: { id: "one", providerID: "w", modelID: "one" } })}\n`);
  } else {
    process.exitCode = 2;
  }
} else {
  writeFileSync(join(process.cwd(), "artifact.txt"), "fixture output");
  writeFileSync(process.env.TASKCTL_FIXTURE_MARKER, "requested");
  console.log(JSON.stringify({ type: "text", sessionID: "offline-session", text: "fixture completed" }));
  appendFileSync(join(process.cwd(), "starts.txt"), "started\n");
  if (process.env.TASKCTL_FIXTURE_EXIT === "1") process.kill(process.pid, "SIGTERM");
  if (process.env.TASKCTL_FIXTURE_HANG === "1") setInterval(() => {}, 1000);
}
