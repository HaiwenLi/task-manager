import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Render a page in headless Chrome and report what a reader would actually see.
 *
 * A reviewer reads code and diffs. It cannot see that the page is blank because a
 * script threw before first paint, or that a table sticks 40px out of a phone
 * viewport. Both happened on the task this was written for, and both survived a
 * careful read of the source. So the verdict here comes from the browser:
 * measured layout, the uncaught exceptions, and a screenshot kept as evidence.
 */

export type Viewport = { width: number; height: number };

/** What the browser says about one file at one viewport. */
export type RenderView = {
  target: string;
  viewport: string;
  ok: boolean;
  /** Machine reasons, empty when `ok`; see {@link PROBLEM_TEXT}. */
  problems: string[];
  screenshot: string;
  measurements: { scrollWidth: number; clientWidth: number; textLength: number; images: number; brokenImages: number };
};

export type RenderCheck = {
  ok: boolean;
  browser: string;
  at: string;
  views: RenderView[];
};

export const PROBLEM_TEXT: Record<string, string> = {
  overflow: "横向溢出：页面比视口宽，内容被裁掉或需要横向滚动",
  blank: "页面是空的：既没有可见文字也没有图片",
  "broken-image": "有图片没加载出来",
  "script-error": "脚本抛了未捕获异常，页面很可能没画完",
};

/** Raised when no browser can be run; a missing check is not a passed check. */
export class RenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderUnavailableError";
  }
}

export const DEFAULT_VIEWPORTS = ["1440x900", "390x844"];

/** Parse `1440x900`; anything else is a caller error, not something to guess at. */
export function parseViewport(spec: string): Viewport {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(spec.trim());
  if (!match) {
    throw new RenderUnavailableError(`viewport "${spec}" is not WIDTHxHEIGHT, e.g. 1440x900`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The first browser that exists, or a clear failure instead of a silent skip. */
export function findBrowser(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.TASKCTL_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new RenderUnavailableError(
    "no Chrome/Chromium found; set TASKCTL_CHROME or the chromeBin config to a browser binary",
  );
}

/** Minimal CDP client: one socket, request/response by id, events by method. */
class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>();
  private readonly waiters = new Map<string, Array<(params: unknown) => void>>();

  constructor(private readonly ws: WebSocketLike) {
    ws.addEventListener("message", (event) => this.onMessage(String((event as { data: unknown }).data)));
  }

  static async connect(url: string, timeoutMs: number): Promise<Cdp> {
    const ws = new WebSocket(url) as unknown as WebSocketLike;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RenderUnavailableError("devtools socket did not open")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new RenderUnavailableError("devtools socket errored")); });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RenderUnavailableError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve on the next `method` event, or reject after `timeoutMs`. */
  next(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RenderUnavailableError(`${method} never fired`)), timeoutMs);
      const list = this.waiters.get(method) ?? [];
      list.push((params) => { clearTimeout(timer); resolve(params); });
      this.waiters.set(method, list);
    });
  }

  /** Subscribe to every future `method` event; these are never consumed. */
  on(method: string, fn: (params: unknown) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  close(): void {
    try { this.ws.close(); } catch { /* already gone */ }
  }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "devtools error"));
      else waiter.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      // One-shot waiters fire once and are dropped; permanent listeners (the
      // exception collector) stay for the whole session.
      const waiting = this.waiters.get(message.method);
      if (waiting) {
        this.waiters.delete(message.method);
        for (const fn of waiting) fn(message.params);
      }
      for (const fn of this.listeners.get(message.method) ?? []) fn(message.params);
    }
  }
}

type WebSocketLike = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
};

/** The in-page measurement. Kept as a string so the browser, not us, evaluates it. */
const MEASURE = `(() => {
  const de = document.documentElement;
  const images = Array.from(document.images || []);
  return {
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    textLength: ((document.body && document.body.innerText) || "").trim().length,
    images: images.length,
    brokenImages: images.filter((img) => img.complete && img.naturalWidth === 0).length,
  };
})()`;

export type CheckOptions = {
  /** Files to open; relative paths resolve against `cwd`. */
  targets: string[];
  viewports?: string[];
  /** Where screenshots land; created if missing. */
  evidenceDir: string;
  chromeBin?: string;
  /** Body text below this is "blank". */
  minText?: number;
  /** Time between load and measurement, for pages that paint after load. */
  settleMs?: number;
  timeoutMs?: number;
};

/**
 * Run the check over every target at every viewport. Throws
 * {@link RenderUnavailableError} when the browser itself cannot run — a check
 * that never happened must not read as a pass.
 */
export async function checkRender(options: CheckOptions): Promise<RenderCheck> {
  const browser = findBrowser(options.chromeBin);
  const viewports = (options.viewports && options.viewports.length > 0 ? options.viewports : DEFAULT_VIEWPORTS).map((spec) => ({
    spec,
    size: parseViewport(spec),
  }));
  const timeoutMs = options.timeoutMs ?? 30_000;
  await mkdir(options.evidenceDir, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), "taskctl-render-"));
  let child: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    child = spawn(browser, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: "ignore" });
    // A browser that exits on launch is a failure, not a slow page. The extra
    // catch keeps a normal shutdown at the end from surfacing as an unhandled
    // rejection once nothing is racing it any more.
    const exited = new Promise<never>((_, reject) => {
      child!.once("exit", (code) => reject(new RenderUnavailableError(`browser exited during startup (code ${code ?? "null"})`)));
    });
    exited.catch(() => undefined);
    const port = await Promise.race([readDevToolsPort(profile, timeoutMs), exited]);
    const page = await Promise.race([openPage(port, timeoutMs), exited]);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl, timeoutMs);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const exceptions: string[] = [];
    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = (params as { exceptionDetails?: { exception?: { description?: string }; text?: string } }).exceptionDetails;
      exceptions.push(details?.exception?.description ?? details?.text ?? "unknown exception");
    });

    const views: RenderView[] = [];
    for (const target of options.targets) {
      const url = pathToFileURL(target.startsWith("/") || /^[A-Za-z]:\\/.test(target) ? target : join(process.cwd(), target)).href;
      for (const viewport of viewports) {
        exceptions.length = 0;
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.size.width,
          height: viewport.size.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const loaded = cdp.next("Page.loadEventFired", timeoutMs);
        await cdp.send("Page.navigate", { url });
        await loaded;
        await sleep(options.settleMs ?? 350);
        const measured = (await cdp.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true }))
          .result.value as RenderView["measurements"];
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        const screenshot = join(options.evidenceDir, `${safeName(target)}-${viewport.spec}.png`);
        await writeFile(screenshot, Buffer.from(String(shot.data), "base64"));
        const problems: string[] = [];
        if (measured.scrollWidth > measured.clientWidth + 1) problems.push("overflow");
        if (measured.textLength < (options.minText ?? 1) && measured.images === 0) problems.push("blank");
        if (measured.brokenImages > 0) problems.push("broken-image");
        if (exceptions.length > 0) problems.push("script-error");
        views.push({
          target,
          viewport: viewport.spec,
          ok: problems.length === 0,
          problems,
          screenshot,
          measurements: measured,
        });
      }
    }
    return { ok: views.every((view) => view.ok), browser, at: new Date().toISOString(), views };
  } finally {
    cdp?.close();
    child?.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** One sentence per failed view, for a journal line or a block reason. */
export function describeFailures(check: RenderCheck): string[] {
  return check.views
    .filter((view) => !view.ok)
    .map((view) => `${view.target} @ ${view.viewport}: ${view.problems.map((p) => PROBLEM_TEXT[p] ?? p).join("；")}`);
}

async function readDevToolsPort(profile: string, timeoutMs: number): Promise<number> {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [line] = (await readFile(file, "utf8")).split(/\r?\n/);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    if (Date.now() > deadline) throw new RenderUnavailableError("browser did not open a debug port");
    await sleep(100);
  }
}

async function openPage(port: number, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  // Chrome requires PUT for /json/new since v111; GET returns a hint page.
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new RenderUnavailableError(`could not open a page target (${response.status})`);
  return await response.json() as { webSocketDebuggerUrl: string };
}

function safeName(target: string): string {
  // Basename for readability, a short digest of the full path so two pages with
  // the same name in different directories do not overwrite each other's evidence.
  const base = (target.split(/[\\/]/).pop() ?? "page").replace(/[^A-Za-z0-9._-]+/g, "-").slice(-40) || "page";
  const digest = createHash("sha1").update(target).digest("hex").slice(0, 6);
  return `${base}-${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
