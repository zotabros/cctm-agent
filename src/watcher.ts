import { stat, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import chokidar from "chokidar";
import pc from "picocolors";
import type { IngestEvent } from "@cctm/shared";
import { CLAUDE_CREDENTIALS, CLAUDE_PROJECTS } from "./config.js";
import { getOffset, persist, setOffset } from "./state.js";
import { parseJsonlLine } from "./parser.js";

interface WatcherDeps {
  onEvents: (events: IngestEvent[]) => void;
}

let cachedClaudeEmail: string | undefined;

async function readClaudeEmail(): Promise<string | undefined> {
  if (cachedClaudeEmail !== undefined) return cachedClaudeEmail;
  try {
    const raw = await readFile(CLAUDE_CREDENTIALS, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const email =
      (json.email as string | undefined) ??
      (json.userEmail as string | undefined) ??
      ((json.account as { email?: string } | undefined)?.email);
    cachedClaudeEmail = typeof email === "string" ? email : undefined;
  } catch {
    cachedClaudeEmail = undefined;
  }
  return cachedClaudeEmail;
}

async function readNewLines(path: string): Promise<{ lines: string[]; newOffset: number }> {
  const st = await stat(path);
  const start = await getOffset(path);
  if (st.size === start) return { lines: [], newOffset: start };
  if (st.size < start) {
    // file was truncated/rotated — restart from 0
    await setOffset(path, 0);
    return readNewLines(path);
  }
  const fd = await open(path, "r");
  try {
    const length = st.size - start;
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, start);
    const text = buf.toString("utf-8");
    // Hold back a partial trailing line until the next write delivers its newline.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { lines: [], newOffset: start };
    const consumed = text.slice(0, lastNl);
    const newOffset = start + Buffer.byteLength(consumed, "utf-8") + 1;
    const lines = consumed.split("\n").filter((l) => l.length > 0);
    return { lines, newOffset };
  } finally {
    await fd.close();
  }
}

async function processFile(path: string, deps: WatcherDeps): Promise<void> {
  if (!path.endsWith(".jsonl")) return;
  const sessionUuid = basename(path, ".jsonl");
  const projectDir = basename(dirname(path));
  const cwd = decodeProjectDir(projectDir);
  const claudeUserEmail = await readClaudeEmail();

  try {
    const { lines, newOffset } = await readNewLines(path);
    if (lines.length === 0) return;
    const events: IngestEvent[] = [];
    for (const line of lines) {
      const ev = parseJsonlLine(line, { sessionUuid, cwd, claudeUserEmail });
      if (ev) events.push(ev);
    }
    if (events.length > 0) deps.onEvents(events);
    await setOffset(path, newOffset);
  } catch (err) {
    console.error(pc.red(`[watcher] ${path}: ${(err as Error).message}`));
  }
}

function decodeProjectDir(name: string): string {
  if (name.startsWith("-")) return "/" + name.slice(1).replace(/-/g, "/");
  return name.replace(/-/g, "/");
}

export function startWatcher(deps: WatcherDeps): chokidar.FSWatcher {
  const pattern = join(CLAUDE_PROJECTS, "**", "*.jsonl");
  console.log(pc.dim(`[watcher] watching ${pattern}`));

  const watcher = chokidar.watch(pattern, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
  });

  const queue = new Map<string, Promise<void>>();
  const enqueue = (path: string): void => {
    const prev = queue.get(path) ?? Promise.resolve();
    const next = prev.then(() => processFile(path, deps)).catch(() => {});
    queue.set(path, next);
  };

  watcher.on("add", enqueue);
  watcher.on("change", enqueue);
  watcher.on("error", (err) => console.error(pc.red(`[watcher] ${err}`)));

  const flushState = (): void => {
    void persist();
  };
  process.on("SIGINT", flushState);
  process.on("SIGTERM", flushState);

  return watcher;
}
