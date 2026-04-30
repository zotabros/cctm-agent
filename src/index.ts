#!/usr/bin/env node
import pc from "picocolors";
import { writeFile, unlink } from "node:fs/promises";
import { ensureConfigDir, loadConfig, PID_PATH } from "./config.js";
import { startWatcher } from "./watcher.js";
import { Uploader } from "./uploader.js";
import { persist } from "./state.js";
import { BUILD_INFO, formatBuildInfo } from "./buildinfo.js";
import { runMenu } from "./menu.js";

function isDaemonInvocation(argv: string[]): boolean {
  if (process.env.CCTM_DAEMON === "1") return true;
  return argv.includes("--daemon");
}

function isBackfillInvocation(argv: string[]): boolean {
  return argv.includes("--backfill");
}

function isVersionFlag(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}

function printVersion(): void {
  console.log(`cctm-agent ${BUILD_INFO.version}`);
  if (BUILD_INFO.commit) console.log(`  commit:      ${BUILD_INFO.commit}`);
  if (BUILD_INFO.branch) console.log(`  branch:      ${BUILD_INFO.branch}`);
  if (BUILD_INFO.commitDate) console.log(`  commit date: ${BUILD_INFO.commitDate}`);
  if (BUILD_INFO.buildDate) console.log(`  build date:  ${BUILD_INFO.buildDate}`);
}

async function runDaemon(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error(pc.red("No config. Run cctm-agent (without flags) to set up."));
    process.exit(1);
  }
  await ensureConfigDir();
  await writeFile(PID_PATH, String(process.pid), "utf-8").catch(() => undefined);
  console.log(pc.bold("cctm-agent") + pc.dim(` → ${cfg.serverUrl} as "${cfg.label}"`));

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
    await unlink(PID_PATH).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isVersionFlag(argv)) {
    printVersion();
    return;
  }
  if (isDaemonInvocation(argv)) {
    await runDaemon();
    return;
  }
  if (isBackfillInvocation(argv)) {
    const { runBackfill } = await import("./backfill.js");
    await runBackfill();
    return;
  }
  if (!process.stdout.isTTY) {
    console.error(pc.red("cctm-agent menu requires an interactive terminal."));
    console.error(pc.dim("Run with --daemon to start the watcher non-interactively."));
    process.exit(1);
  }
  console.log(pc.dim(`cctm-agent ${formatBuildInfo()}`));
  await runMenu();
}

main().catch((err: unknown) => {
  console.error(pc.red((err as Error).stack ?? String(err)));
  process.exit(1);
});
