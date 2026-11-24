// Fake opencode CLI — the test double for OpenCodeAdapter (Task 6).
//
// Mirrors exactly the surfaces the adapter uses. The `run` transcript was
// verified against the real opencode v2.0.29 CLI; the session shapes were
// re-verified against v2.4.1 on 2026-11-24 (never invoked in tests):
//
//   run                         → NDJSON event lines on stdout; one JSON object
//                                  per line; every line carries sessionID. Exit
//                                  code comes from $FAKE_EXIT_CODE (default 0).
//   api session.get --param …   → one JSON object {"data":…} WITHOUT a model:
//                                  v2.4.1 answers id/projectID/cost/tokens/
//                                  outcome/time/title/location only
//   api session.message.list    → {"data":[…]} newest first; each assistant
//                                  message carries model {providerID, id}
//   api model.list              → one JSON object {"data":[…]} with one record
//                                  per model: {id, modelID, providerID, cost,
//                                  enabled, variants: [{id}], settings,
//                                  headers, …} (verified 2026-11-25)
//   api model.default           → one JSON object {"location":…,"data":{…}}
//                                  whose data is one such record
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
//   FAKE_SESSION_STATUS / _PROVIDER / _MODEL / _CWD — the session the `api`
//                      face answers for: idle | active | missing, the model it
//                      last ran on, and its directory
//   FAKE_SESSION_MODELS — JSON array of `provider/id`, oldest first: one
//                      assistant message per entry (default: the single
//                      FAKE_SESSION_PROVIDER/FAKE_SESSION_MODEL turn)
//   FAKE_MESSAGES_OLDEST_FIRST — list messages oldest first; the adapter must
//                      pick by message time, not by position
//   FAKE_SESSION_MODEL_IN_GET — put `model` back on session.get, as services
//                      before 2.4 did
//   FAKE_MESSAGE_LIST_FAILS — `api session.message.list` fails: a service
//                      without the operation
//   FAKE_MODEL_LIST_FAILS_ONCE — `api model.list` fails once: name a marker
//                      file, the first call fails while creating it and every
//                      later call answers normally
//   FAKE_MODEL_LIST_EMPTY_ONCE — the same, but the first call answers an
//                      empty list with exit code 0: the real service did that
//                      once where three later probes answered 124 models
//                      each (2026-11-25), so empty is not taken for truth
//   FAKE_MODEL_DEFAULT_FAILS_ONCE — `api model.default` fails once, the same
//                      way as FAKE_MODEL_LIST_FAILS_ONCE
//   FAKE_MODEL_DEFAULT_NONE — `api model.default` answers `data: null`: a
//                      backend without a default model
//   paid-default (a file in the directory the fake is started in) — that
//                      directory stands for one with its own `opencode.json`,
//                      where the real service answered another default model
//                      and another list (2026-11-25): `api model.default`
//                      answers anthropic/opus, and `api model.list` lists one
//                      model more
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

// Every model record the real service answers carries credentials
// (`settings.apiKey`, `headers`). The values are fake: the adapter has to
// rebuild each catalogue entry from named fields only, which is what the
// catalogue tests check.
const credentials = {
  settings: { apiKey: "sk-FAKE-not-a-real-key" },
  headers: { authorization: "Bearer FAKE-not-a-real-token" },
};

// The answers of `api model.*` depend on the directory the fake is started
// in, as the real service's do: it finds its configuration from there.
const paidDefault = existsSync("paid-default");

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
        ...(process.env.FAKE_SESSION_MODEL_IN_GET
          ? { model: { providerID: process.env.FAKE_SESSION_PROVIDER ?? "anthropic", id: process.env.FAKE_SESSION_MODEL ?? "sonnet", variant: "default" } }
          : {}),
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
} else if (subcommand === "api" && operation === "session.message.list") {
  // The model a session ran on lives on its assistant messages (v2.4.1). Only
  // the shapes the adapter reads are reproduced: newest first by default.
  if (process.env.FAKE_MESSAGE_LIST_FAILS) {
    process.stderr.write(`UnknownError: Operation not found: session.message.list\n`);
    process.exitCode = 1;
  } else {
    const models = JSON.parse(process.env.FAKE_SESSION_MODELS
      ?? JSON.stringify([`${process.env.FAKE_SESSION_PROVIDER ?? "anthropic"}/${process.env.FAKE_SESSION_MODEL ?? "sonnet"}`]));
    const now = Date.now();
    const turns = models.map((model, index) => {
      const slash = model.indexOf("/");
      const at = now - (models.length - index) * 1000;
      return [
        { id: `msg_u${index}`, time: { created: at - 500 }, type: "user", text: "do it" },
        {
          id: `msg_a${index}`, time: { created: at }, type: "assistant",
          model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) }, content: [],
        },
      ];
    }).flat();
    const idle = { id: "msg_idle", time: { created: now }, type: "idle", outcome: "succeeded" };
    const data = process.env.FAKE_MESSAGES_OLDEST_FIRST ? [...turns, idle] : [idle, ...[...turns].reverse()];
    process.stdout.write(`${JSON.stringify({ data, cursor: { next: null } })}\n`);
    process.exitCode = 0;
  }
} else if (subcommand === "api" && operation === "model.list") {
  // A failed fetch must not be remembered: name a marker file in
  // FAKE_MODEL_LIST_FAILS_ONCE and the first call fails while creating it;
  // every later call answers normally. FAKE_MODEL_LIST_EMPTY_ONCE works the
  // same way, but the first call answers an empty list with exit code 0: the
  // real service did that once where three later probes answered 124 models
  // each (2026-11-25), so an empty answer is not taken for truth either.
  const failOnce = process.env.FAKE_MODEL_LIST_FAILS_ONCE;
  const emptyOnce = process.env.FAKE_MODEL_LIST_EMPTY_ONCE;
  if (failOnce && !existsSync(failOnce)) {
    writeFileSync(failOnce, "failed once", "utf8");
    process.stderr.write(`UnknownError: service unreachable\n`);
    process.exitCode = 1;
  } else if (emptyOnce && !existsSync(emptyOnce)) {
    writeFileSync(emptyOnce, "answered empty once", "utf8");
    process.stdout.write(`${JSON.stringify({ data: [] })}\n`);
    process.exitCode = 0;
  } else {
  // One record per model with the cost it reports: all-zero is a free model,
  // a missing cost field is a model whose cost the service does not say, a
  // positive cost is a priced one. A cost row may carry a `cache` object.
  process.stdout.write(
    `${JSON.stringify({
      data: [
        { id: "sonnet", providerID: "anthropic", cost: [{ input: 0, output: 0 }], limit: { context: 200000, output: 16000 }, ...credentials },
        // Listed only in a directory that holds `paid-default`.
        ...(paidDefault ? [{ id: "only-in-paid", providerID: "anthropic", cost: [{ input: 3, output: 15 }] }] : []),
        // A model that publishes effort variants (like the coding plans do).
        { id: "gpt", providerID: "openai", variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 0, output: 0 }], limit: { context: 128000, output: 8000 }, ...credentials },
        { id: "local-model", providerID: "ollama", limit: { context: 8192, output: 4096 }, ...credentials },
        { id: "opus", providerID: "anthropic", cost: [{ input: 15, output: 75 }], ...credentials },
        // Listed under an upstream name too: one model, one catalogue entry.
        { id: "k", modelID: "k-alias", providerID: "p", cost: [{ input: 0, output: 0 }], ...credentials },
      ],
    })}\n`,
  );
  process.exitCode = 0;
  }
} else if (subcommand === "api" && operation === "model.default") {
  // The backend's default model, in the real service's envelope: `location` is
  // the caller's directory and the adapter ignores it; `data` is one model
  // record, credentials included. FAKE_MODEL_DEFAULT_NONE answers a backend
  // without a default (`data: null`); FAKE_MODEL_DEFAULT_FAILS_ONCE fails the
  // first call the way FAKE_MODEL_LIST_FAILS_ONCE does. In a directory that
  // holds `paid-default` the default is the paid anthropic/opus.
  const failOnce = process.env.FAKE_MODEL_DEFAULT_FAILS_ONCE;
  if (failOnce && !existsSync(failOnce)) {
    writeFileSync(failOnce, "failed once", "utf8");
    process.stderr.write(`UnknownError: service unreachable\n`);
    process.exitCode = 1;
  } else if (process.env.FAKE_MODEL_DEFAULT_NONE) {
    process.stdout.write(`${JSON.stringify({ location: { directory: "." }, data: null })}\n`);
    process.exitCode = 0;
  } else {
  process.stdout.write(
    `${JSON.stringify({
      location: { directory: "." },
      data: paidDefault
        ? { id: "opus", providerID: "anthropic", modelID: "opus", ...credentials }
        : { id: "sonnet", providerID: "anthropic", modelID: "sonnet", ...credentials },
    })}\n`,
  );
  process.exitCode = 0;
  }
} else {
  process.stderr.write(`fake-opencode: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
}
