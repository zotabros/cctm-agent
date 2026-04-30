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

function isInventoryInvocation(argv: string[]): boolean {
  return argv.includes("--inventory");
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

  // Inventory: upload once on start, then every 24h.
  const { uploadInventory } = await import("./inventory.js");
  const tickInventory = async (): Promise<void> => {
    try {
      const r = await uploadInventory(cfg.serverUrl, cfg.token);
      if (!r.ok) console.error(pc.dim(`[inventory] upload failed (${r.status})`));
    } catch (e) {
      console.error(pc.dim(`[inventory] error: ${(e as Error).message}`));
    }
  };
  void tickInventory();
  const inventoryTimer = setInterval(() => void tickInventory(), 24 * 60 * 60 * 1000);
  inventoryTimer.unref();

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
  if (isInventoryInvocation(argv)) {
    const cfg = await loadConfig();
    if (!cfg) {
      console.error(pc.red("No config. Run cctm-agent (without flags) to set up first."));
      process.exit(1);
    }
    const { uploadInventory } = await import("./inventory.js");
    const result = await uploadInventory(cfg.serverUrl, cfg.token);
    if (result.ok) {
      console.log(pc.green("✓ Inventory snapshot uploaded."));
      console.log(pc.dim(result.body));
    } else {
      console.error(pc.red(`✗ Upload failed (${result.status}): ${result.body}`));
      process.exit(1);
    }
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
