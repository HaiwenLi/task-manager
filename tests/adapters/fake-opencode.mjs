// Fake opencode CLI — the test double for OpenCodeAdapter (Task 6).
//
// Mirrors exactly the two surfaces the adapter uses, as verified against the
// real opencode v2.0.29 CLI (never invoked in tests):
//
//   run                       → NDJSON event lines on stdout; one JSON object
//                               per line; every line carries sessionID. Exit
//                               code comes from $FAKE_EXIT_CODE (default 0).
//   api session.get --param … → one JSON object {"location":…,"data":…}
//   api model.list            → one JSON object {"data":[…]}
//
// Extra test hooks, all optional and inherited via process.env:
//   FAKE_ARGV_FILE   — path to write the received argv (JSON array) to, so
//                      tests can assert on the exact spawn arguments
//   FAKE_EXIT_CODE   — run's exit code (Review Focus 4: exit 1 must resolve,
//                      not reject)
//   FAKE_CWD_MARKER  — when set, `run` writes fake-cwd-marker.txt into its
//                      current working directory, proving {cwd} was applied
//   FAKE_STDERR_TEXT — text written to stderr before any stdout; combined
//                      with FAKE_STDERR_REPEAT it can exceed any pipe buffer,
//                      proving the adapter drains stderr (a full pipe would
//                      otherwise block the child forever)
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (process.env.FAKE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv), "utf8");
}

if (process.env.FAKE_STDERR_TEXT) {
  process.stderr.write(process.env.FAKE_STDERR_TEXT.repeat(Number(process.env.FAKE_STDERR_REPEAT ?? 1)));
}

const [subcommand, operation] = argv;

if (subcommand === "run") {
  // Preset turn transcript: a text line carrying sessionID first (as in the
  // real CLI), then other event types, one deliberately unparseable line the
  // adapter must skip, then a second text event whose text is appended.
  const lines = [
    '{"sessionID":"ses_fake123","type":"text","text":"你好"}',
    '{"sessionID":"ses_fake123","type":"step_start","info":{"title":"读取任务"}}',
    "not-json {{{ must be skipped",
    '{"sessionID":"ses_fake123","type":"tool_use","tool":"read","args":{"path":"a.md"}}',
    '{"sessionID":"ses_fake123","type":"text","text":"，任务完成"}',
    '{"sessionID":"ses_fake123","type":"step_finish"}',
  ];
  if (process.env.FAKE_CWD_MARKER) {
    writeFileSync("fake-cwd-marker.txt", "x", "utf8");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
} else if (subcommand === "api" && operation === "session.get") {
  // --param sessionID=<id> → tokens telemetry; the sum input+output+
  // reasoning+cache.read+cache.write = 1375 is what the adapter must report.
  const paramIndex = argv.indexOf("--param");
  const param = paramIndex >= 0 ? argv[paramIndex + 1] : "";
  const sessionID = param.startsWith("sessionID=") ? param.slice("sessionID=".length) : "";
  process.stdout.write(
    `${JSON.stringify({
      location: `/session/${sessionID}`,
      data: { tokens: { input: 1000, output: 200, reasoning: 100, cache: { read: 50, write: 25 } } },
    })}\n`,
  );
  process.exitCode = 0;
} else if (subcommand === "api" && operation === "model.list") {
  process.stdout.write(
    `${JSON.stringify({
      data: [
        { id: "sonnet", providerID: "anthropic", limit: { context: 200000, output: 16000 } },
        { id: "gpt", providerID: "openai", limit: { context: 128000, output: 8000 } },
        { id: "local-model", providerID: "ollama", limit: { context: 8192, output: 4096 } },
      ],
    })}\n`,
  );
  process.exitCode = 0;
} else {
  process.stderr.write(`fake-opencode: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
}
