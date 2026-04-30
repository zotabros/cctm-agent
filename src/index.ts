#!/usr/bin/env node
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { runInit } from "./init.js";
import { startWatcher } from "./watcher.js";
import { Uploader } from "./uploader.js";
import { persist } from "./state.js";
import { runBackfill } from "./backfill.js";
import { BUILD_INFO, formatBuildInfo } from "./buildinfo.js";

interface ParsedArgs {
  cmd: "init" | "run" | "backfill" | "version" | "help";
  flags: Record<string, string | undefined>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [cmdRaw, ...rest] = argv;
  let cmd: ParsedArgs["cmd"];
  if (cmdRaw === "init" || cmdRaw === "run" || cmdRaw === "backfill" || cmdRaw === "version") {
    cmd = cmdRaw;
  } else if (cmdRaw === "--version" || cmdRaw === "-v") {
    cmd = "version";
  } else {
    cmd = "help";
  }
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return { cmd, flags };
}

function printBanner(): void {
  console.log(pc.dim(`cctm-agent ${formatBuildInfo()}`));
}

function printVersion(): void {
  console.log(`cctm-agent ${BUILD_INFO.version}`);
  if (BUILD_INFO.commit)     console.log(`  commit:      ${BUILD_INFO.commit}`);
  if (BUILD_INFO.branch)     console.log(`  branch:      ${BUILD_INFO.branch}`);
  if (BUILD_INFO.commitDate) console.log(`  commit date: ${BUILD_INFO.commitDate}`);
  if (BUILD_INFO.buildDate)  console.log(`  build date:  ${BUILD_INFO.buildDate}`);
}

function printHelp(): void {
  console.log(`${pc.bold("cctm-collect")} — Claude Code usage collector

Commands:
  init     Configure server URL, label, token
  run      Watch ~/.claude/projects and stream usage to the server
  backfill Walk all existing JSONL files and upload (idempotent)
  version  Print version, git commit, and build date

Init flags:
  --server <url>   Server base URL (e.g. https://cctm.example.com)
  --label  <name>  Machine label
  --token  <tok>   Machine API token (from dashboard)
`);
}

async function runRun(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error(pc.red('No config. Run "cctm-collect init" first.'));
    process.exit(1);
  }
  console.log(pc.bold(`cctm-collect`) + pc.dim(` → ${cfg.serverUrl} as "${cfg.label}"`));

  const uploader = new Uploader(cfg);
  uploader.start();

  startWatcher({
    onEvents: (events) => uploader.push(events),
  });

  const shutdown = async (): Promise<void> => {
    console.log(pc.dim("\n[main] flushing..."));
    await uploader.flush();
    await persist();
    uploader.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "version") {
    printVersion();
    return;
  }
  if (cmd !== "help") printBanner();
  if (cmd === "init") {
    await runInit({ server: flags.server, token: flags.token, label: flags.label });
    return;
  }
  if (cmd === "run") {
    await runRun();
    return;
  }
  if (cmd === "backfill") {
    await runBackfill();
    return;
  }
  printHelp();
}

main().catch((err: unknown) => {
  console.error(pc.red((err as Error).stack ?? String(err)));
  process.exit(1);
});
