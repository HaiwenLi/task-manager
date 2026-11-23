// Provider refusals must stay refusals — a retryable failure that rotates to
// the next model in the chain, never an "uncertain execution" that blocks the
// task (2026-11-23: a provider hiccup wedged a whole board because the
// refusal was not recognised, and an effort variant a model does not publish
// killed the turn in half a second).
import { afterEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

const fixture = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
const adapter = (): OpenCodeAdapter => new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fixture] });

afterEach(() => {
  delete process.env.FAKE_PROVIDER_NOROUTE;
  delete process.env.FAKE_PROVIDER_RETRY;
  delete process.env.FAKE_EXIT_CODE;
});

it("keeps the effort variant only when the model publishes it", async () => {
  const a = adapter();
  // The model publishes `high`: the variant is requested.
  await expect(a.resolveModel("openai/gpt", "high")).resolves.toBe("openai/gpt#high");
  // The model publishes no variants: asking for one is refused by the
  // provider (`provider.no-route`), so the plain model is dispatched.
  await expect(a.resolveModel("anthropic/sonnet", "high")).resolves.toBe("anthropic/sonnet");
  // An unknown model keeps the old behaviour: the provider, not this lookup,
  // is the authority on what it accepts.
  await expect(a.resolveModel("unknown/model", "high")).resolves.toBe("unknown/model#high");
  await expect(a.resolveModel("openai/gpt", undefined)).resolves.toBe("openai/gpt");
  await expect(a.resolveModel(undefined, "high")).resolves.toBeUndefined();
});

it("a no-route refusal is a provider failure, not an uncertain turn", async () => {
  process.env.FAKE_PROVIDER_NOROUTE = "1";
  process.env.FAKE_EXIT_CODE = "1";
  const result = await adapter().prompt({ text: "hi", cwd: process.cwd() });
  expect(result.exitCode).toBe(1);
  expect(result.failure).toBe("provider");
});

it("a refused retry loop is a provider failure too", async () => {
  process.env.FAKE_PROVIDER_RETRY = "1";
  process.env.FAKE_EXIT_CODE = "1";
  const result = await adapter().prompt({ text: "hi", cwd: process.cwd() });
  expect(result.exitCode).toBe(1);
  expect(result.failure).toBe("provider");
});

it("a clean success is not a provider failure", async () => {
  const result = await adapter().prompt({ text: "hi", cwd: process.cwd() });
  expect(result.exitCode).toBe(0);
  expect(result.failure).toBeUndefined();
});
