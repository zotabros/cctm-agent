import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import pc from "picocolors";
import type { IngestEvent } from "@cctm/shared";
import { CLAUDE_PROJECTS, CLAUDE_CREDENTIALS, loadConfig } from "./config.js";
import { parseJsonlLine } from "./parser.js";
import { getPinnedEmail, pinEmail } from "./state.js";
import { Uploader } from "./uploader.js";

async function* walkJsonl(root: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkJsonl(full);
    } else if (st.isFile() && name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

function decodeProjectDir(name: string): string {
  if (name.startsWith("-")) return "/" + name.slice(1).replace(/-/g, "/");
  return name.replace(/-/g, "/");
}

async function readClaudeEmail(): Promise<string | undefined> {
  try {
    const raw = await readFile(CLAUDE_CREDENTIALS, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const email =
      (json.email as string | undefined) ??
      (json.userEmail as string | undefined) ??
      ((json.account as { email?: string } | undefined)?.email);
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

export async function runBackfill(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error(pc.red('No config. Run "cctm-collect init" first.'));
    process.exit(1);
  }
  const fallbackEmail = await readClaudeEmail();
  console.log(
    pc.bold("cctm-collect backfill") +
      pc.dim(` → ${cfg.serverUrl} as "${cfg.label}"`)
  );

  const uploader = new Uploader(cfg);
  uploader.start();

  let files = 0;
  let totalEvents = 0;
  let skipped = 0;

  for await (const filePath of walkJsonl(CLAUDE_PROJECTS)) {
    files++;
    const sessionUuid = basename(filePath, ".jsonl");
    const projectDir = basename(dirname(filePath));
    const cwd = decodeProjectDir(projectDir);

    // Honour any pinned email captured live by the watcher. Only fall back to
    // the currently-logged-in account for files that have never been seen
    // (otherwise re-running backfill after switching accounts would silently
    // re-attribute history to the new account — the bug this fix addresses).
    let claudeUserEmail = await getPinnedEmail(filePath);
    if (!claudeUserEmail && fallbackEmail) {
      claudeUserEmail = fallbackEmail;
      await pinEmail(filePath, fallbackEmail);
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      skipped++;
      console.error(pc.yellow(`[backfill] skip ${filePath}: ${(err as Error).message}`));
      continue;
    }
    const events: IngestEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const ev = parseJsonlLine(line, { sessionUuid, cwd, claudeUserEmail });
      if (ev) events.push(ev);
    }
    if (events.length === 0) {
      skipped++;
      continue;
    }
    uploader.push(events);
    totalEvents += events.length;
    if (files % 50 === 0) {
      console.log(
        pc.dim(`[backfill] scanned ${files} files, queued ${totalEvents} events`)
      );
    }
  }

  console.log(
    pc.dim(`[backfill] done scanning. files=${files} events=${totalEvents} skipped=${skipped}`)
  );
  console.log(pc.dim("[backfill] flushing uploader…"));
  await uploader.flush();
  // small drain loop in case anything was left
  for (let i = 0; i < 10; i++) {
    await uploader.flush();
    await new Promise((r) => setTimeout(r, 200));
  }
  uploader.stop();
  console.log(pc.green(`✓ Back-fill complete (${totalEvents} events from ${files} files).`));
}
