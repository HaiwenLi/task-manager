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
//   FAKE_PROVIDER_NOROUTE — emit a `provider.no-route` error event (the
//                      provider refusing a variant it does not publish) and
//                      exit non-zero: the adapter must classify this as a
//                      retryable provider failure, not an uncertain turn
//   FAKE_PROVIDER_RETRY   — emit a `retry` event carrying a rate-limit error
//                      and exit non-zero: opencode's own retry loop gave up
//   FAKE_RUN_HANG         — after the transcript, never exit: the stand-in for
//                      an agent turn still running when the controller cancels it
//   FAKE_INTERRUPT_FILE   — `api session.interrupt` appends the sessionID it
//                      was asked to stop to this file
//   FAKE_INTERRUPT_UNAVAILABLE — `api session.interrupt` fails: an older or
//                      unreachable service
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (process.env.FAKE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv), "utf8");
}
if (process.env.FAKE_API_LOG && argv[0] === "api") {
  appendFileSync(process.env.FAKE_API_LOG, `${argv.slice(0, 2).join(" ")}\n`, "utf8");
}

if (process.env.FAKE_STDERR_TEXT) {
  process.stderr.write(process.env.FAKE_STDERR_TEXT.repeat(Number(process.env.FAKE_STDERR_REPEAT ?? 1)));
}

const [subcommand, operation] = argv;

if (subcommand === "run") {
  // Provider refusals: the CLI exits non-zero after the backend refused the
  // turn. Both shapes must be recognised as retryable provider failures.
  if (process.env.FAKE_PROVIDER_NOROUTE) {
    process.stdout.write(
      `${JSON.stringify({
        sessionID: "ses_fake123",
        type: "error",
        error: { type: "provider.no-route", message: "Variant unavailable for anthropic/sonnet: high" },
      })}\n`,
    );
    process.exitCode = Number(process.env.FAKE_EXIT_CODE ?? 1);
  } else if (process.env.FAKE_PROVIDER_RETRY) {
    process.stdout.write(
      `${JSON.stringify({
        sessionID: "ses_fake123",
        type: "retry",
        attempt: 4,
        error: { type: "provider.rate-limit", message: "该模型当前访问量过大", status: 429 },
      })}\n`,
    );
    process.exitCode = Number(process.env.FAKE_EXIT_CODE ?? 1);
  } else {
  // Preset turn transcript: a text line carrying sessionID first (as in the
  // real CLI), then other event types, one deliberately unparseable line the
  // adapter must skip, then a second text event whose text is appended.
  const lines = [
    '{"sessionID":"ses_fake123","type":"text","text":"你好"}',
    '{"sessionID":"ses_fake123","type":"step_start","info":{"title":"读取任务"}}',
    "not-json {{{ must be skipped",
    '{"sessionID":"ses_fake123","type":"tool_use","tool":"read","args":{"path":"a.md"}}',
    '{"sessionID":"ses_fake123","type":"text","text":"，任务完成"}',
    // opencode >= 2.2 shape: the payload moved under `part`.
    '{"sessionID":"ses_fake123","type":"text","part":{"type":"text","text":"。"}}',
    '{"sessionID":"ses_fake123","type":"step_finish"}',
  ];
  if (process.env.FAKE_CWD_MARKER) {
    writeFileSync("fake-cwd-marker.txt", "x", "utf8");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
  if (process.env.FAKE_RUN_HANG) {
    // A turn still in flight: keep the client alive until it is cancelled.
    process.stdout.write('{"sessionID":"ses_fake123","type":"text","part":{"type":"text","text":"still working"}}\n');
    setInterval(() => {}, 60_000);
  }
  }
} else if (subcommand === "api" && operation === "session.get") {
  // --param sessionID=<id> → tokens telemetry; the sum input+output+
  // reasoning+cache.read+cache.write = 1375 is what the adapter must report.
  const paramIndex = argv.indexOf("--param");
  const param = paramIndex >= 0 ? argv[paramIndex + 1] : "";
  const sessionID = param.startsWith("sessionID=") ? param.slice("sessionID=".length) : "";
  process.stdout.write(
    `${JSON.stringify({
      location: `/session/${sessionID}`,
      data: process.env.FAKE_SESSION_STATUS === "missing" ? null : {
        tokens: { input: 1000, output: 200, reasoning: 100, cache: { read: 50, write: 25 } },
        cost: 0.25,
        model: { providerID: process.env.FAKE_SESSION_PROVIDER ?? "anthropic", id: process.env.FAKE_SESSION_MODEL ?? "sonnet", variant: "default" },
        location: { directory: process.env.FAKE_SESSION_CWD ?? process.cwd() },
        time: process.env.FAKE_SESSION_STATUS === "active"
          ? { busy: Date.now() }
          : process.env.FAKE_SESSION_STATUS === "idle" ? { idle: Date.now() } : {},
        ...(process.env.FAKE_SESSION_STATUS === "idle" ? { outcome: "completed" } : {}),
      },
    })}\n`,
  );
  process.exitCode = 0;
} else if (subcommand === "api" && operation === "session.interrupt") {
  // The service's stop operation. FAKE_INTERRUPT_FILE records which session
  // was asked to stop, so a test can prove the adapter interrupts the session
  // it observed in the stream; FAKE_INTERRUPT_UNAVAILABLE models an older or
  // unreachable service, which must leave the cancellation unconfirmed.
  const paramIndex = argv.indexOf("--param");
  const param = paramIndex >= 0 ? argv[paramIndex + 1] : "";
  const sessionID = param.startsWith("sessionID=") ? param.slice("sessionID=".length) : "";
  if (process.env.FAKE_INTERRUPT_UNAVAILABLE) {
    process.stderr.write(`UnknownError: Operation not found: session.abort\n`);
    process.exitCode = 1;
  } else {
    if (process.env.FAKE_INTERRUPT_FILE) {
      appendFileSync(process.env.FAKE_INTERRUPT_FILE, `${sessionID}\n`);
    }
    // Bare reply, exactly as the real service answers this operation (no
    // envelope): a double that invents a wrapper here passes the unit tests
    // and fails against the real CLI.
    process.stdout.write(`${JSON.stringify({ interrupted: true })}\n`);
    process.exitCode = 0;
  }
} else if (subcommand === "api" && operation === "model.list") {
  process.stdout.write(
    `${JSON.stringify({
      data: [
        { id: "sonnet", providerID: "anthropic", limit: { context: 200000, output: 16000 } },
        // A model that publishes effort variants (like the coding plans do).
        { id: "gpt", providerID: "openai", variants: [{ id: "low" }, { id: "high" }], limit: { context: 128000, output: 8000 } },
        { id: "local-model", providerID: "ollama", limit: { context: 8192, output: 4096 } },
      ],
    })}\n`,
  );
  process.exitCode = 0;
} else {
  process.stderr.write(`fake-opencode: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
}
