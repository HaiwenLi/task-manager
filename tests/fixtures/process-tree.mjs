import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One adapter test uses this fixture as an opencode stand-in. It is not a
// service, so a control-plane call gets no answer - and must not start a
// process tree of its own that would outlive the test.
if (process.argv[2] === "api") process.exit(2);

if (process.argv[2] === "leaf") {
  writeFileSync("descendant.pid", String(process.pid));
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "leaf"], {
    stdio: "inherit",
  });
  if (process.argv.includes("exit-parent")) {
    process.stdout.write(String(process.pid));
    setTimeout(() => process.exit(0), 200);
  }
}
setInterval(() => {}, 1000);
