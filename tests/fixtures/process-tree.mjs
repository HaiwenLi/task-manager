import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
