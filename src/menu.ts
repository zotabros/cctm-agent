import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import prompts from "prompts";
import pc from "picocolors";
import {
  CONFIG_PATH,
  PID_PATH,
  STATE_PATH,
  QUEUE_PATH,
  LOG_DIR,
  deleteConfig,
  loadPartialConfig,
  savePartialConfig,
  type Config,
  type PartialConfig,
} from "./config.js";
import {
  detectState,
  describeState,
  clearStalePid,
  probeServer,
  type AgentState,
} from "./state-detect.js";
import { startDaemon, stopDaemon, restartDaemon, latestLogPath } from "./daemon.js";
import { runSetupWizard, runPairFlow, defaultLabel, promptServerUrl, promptLabel } from "./init.js";
import { runBackfill } from "./backfill.js";
import { unlink } from "node:fs/promises";
import {
  describeAutostart,
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
} from "./autostart.js";

interface MenuChoice {
  title: string;
  value: string;
  description?: string;
}

const cancelOpts = {
  onCancel: (): boolean => {
    return false;
  },
};

function maskToken(t: string | undefined): string {
  if (!t) return "(none)";
  if (t.length <= 12) return t.slice(0, 2) + "***";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

async function header(state: AgentState): Promise<void> {
  console.log("");
  console.log(pc.bold("cctm-agent") + pc.dim(`  ·  ${describeState(state)}`));
  if (state.kind !== "fresh") {
    const cfg = "config" in state ? state.config : null;
    if (cfg) {
      console.log(pc.dim(`  Server: ${cfg.serverUrl}`));
      console.log(pc.dim(`  Label:  ${cfg.label}`));
      if ("token" in cfg) console.log(pc.dim(`  Token:  ${maskToken(cfg.token)}`));
    }
    const ast = await getAutostartStatus();
    console.log(pc.dim(`  ${describeAutostart(ast)}`));
  }
  console.log("");
}

function buildChoices(state: AgentState, autostartEnabled: boolean): MenuChoice[] {
  const autoToggle: MenuChoice = autostartEnabled
    ? { title: "Disable auto-start on boot", value: "autostart-off" }
    : { title: "Enable auto-start on boot", value: "autostart-on" };
  switch (state.kind) {
    case "fresh":
      return [
        { title: "Setup new install", value: "setup" },
        { title: "Quit", value: "quit" },
      ];
    case "partial":
      return [
        { title: "Resume pairing", value: "pair" },
        { title: "Change server URL", value: "change-server" },
        { title: "Reset (clear config)", value: "uninstall" },
        { title: "Quit", value: "quit" },
      ];
    case "idle":
      return [
        { title: "Start daemon", value: "start" },
        autoToggle,
        { title: "Pair again (rotate token)", value: "pair" },
        { title: "Backfill historical sessions", value: "backfill" },
        { title: "Show status / config", value: "show" },
        { title: "Test connection", value: "probe" },
        { title: "Change server URL", value: "change-server" },
        { title: "Change machine label", value: "change-label" },
        { title: "Uninstall (remove config)", value: "uninstall" },
        { title: "Quit", value: "quit" },
      ];
    case "running":
      return [
        { title: "Stop daemon", value: "stop" },
        { title: "Restart daemon", value: "restart" },
        autoToggle,
        { title: "View live status", value: "live-status" },
        { title: "Tail logs", value: "tail" },
        { title: "Pair again (rotate token)", value: "pair" },
        { title: "Backfill historical sessions", value: "backfill" },
        { title: "Show status / config", value: "show" },
        { title: "Quit (leave daemon running)", value: "quit" },
      ];
    case "unreachable":
      return [
        { title: "Retry connection", value: "retry" },
        { title: "Change server URL", value: "change-server" },
        { title: "Show status / config", value: "show" },
        { title: "Quit", value: "quit" },
      ];
    case "unauthorized":
      return [
        { title: "Pair again (token revoked)", value: "pair" },
        { title: "Change server URL", value: "change-server" },
        { title: "Show status / config", value: "show" },
        { title: "Quit", value: "quit" },
      ];
    case "stale-pid":
      return [
        { title: "Clear stale PID and continue", value: "clear-pid" },
        { title: "Quit", value: "quit" },
      ];
  }
}

async function confirm(message: string, initial = false): Promise<boolean> {
  const r = await prompts(
    { type: "confirm", name: "ok", message, initial },
    cancelOpts
  );
  return r.ok === true;
}

export async function runMenu(): Promise<void> {
  // Loop: detect state, render menu, dispatch action.
  for (;;) {
    const state = await detectState();
    if (state.kind === "stale-pid") {
      console.log(pc.yellow(`Clearing stale PID file (process ${state.pid} not running).`));
      await clearStalePid();
      continue;
    }
    await header(state);
    const ast = await getAutostartStatus();
    const choices = buildChoices(state, ast.enabled);
    const { action } = await prompts(
      {
        type: "select",
        name: "action",
        message: "What do you want to do?",
        choices,
        initial: 0,
      },
      cancelOpts
    );
    if (!action || action === "quit") {
      console.log(pc.dim("\nGoodbye."));
      return;
    }

    try {
      const exit = await dispatch(action, state);
      if (exit) return;
    } catch (err) {
      console.error(pc.red(`\nError: ${(err as Error).message}`));
      await prompts(
        { type: "text", name: "_", message: "Press Enter to continue" },
        cancelOpts
      );
    }
  }
}

async function dispatch(action: string, state: AgentState): Promise<boolean> {
  switch (action) {
    case "setup": {
      const cfg = await runSetupWizard();
      if (cfg) await maybeStartAfterSetup(cfg);
      return false;
    }
    case "pair": {
      const partial = await ensurePartialConfig();
      if (!partial) return false;
      if (state.kind === "running") {
        const ok = await confirm(
          "Daemon is running. After re-pairing you must restart it. Continue?",
          true
        );
        if (!ok) return false;
      }
      const cfg = await runPairFlow(partial);
      if (cfg && state.kind === "running") {
        const ok = await confirm("Restart daemon now to use new token?", true);
        if (ok) {
          const r = await restartDaemon();
          console.log(pc.green(`✓ Daemon restarted (pid ${r.pid}).`));
        }
      }
      return false;
    }
    case "start": {
      const r = await startDaemon();
      console.log(pc.green(`✓ Daemon started (pid ${r.pid}).`));
      console.log(pc.dim(`  logs: ${r.logPath}`));
      return false;
    }
    case "stop": {
      const r = await stopDaemon();
      if (r.stopped) console.log(pc.green(`✓ Daemon stopped (pid ${r.pid}).`));
      else console.log(pc.yellow("Daemon was not running."));
      return false;
    }
    case "restart": {
      const r = await restartDaemon();
      console.log(pc.green(`✓ Daemon restarted (pid ${r.pid}).`));
      return false;
    }
    case "backfill": {
      console.log(pc.dim("\nRunning backfill — this may take a few minutes…\n"));
      await runBackfill();
      return false;
    }
    case "show": {
      await showStatus();
      await prompts({ type: "text", name: "_", message: "Press Enter to continue" }, cancelOpts);
      return false;
    }
    case "probe": {
      const cfg = "config" in state ? state.config : null;
      if (!cfg || !cfg.token) {
        console.log(pc.red("No token configured."));
        return false;
      }
      console.log(pc.dim("Probing server…"));
      const p = await probeServer(cfg.serverUrl, cfg.token);
      if (p.kind === "ok") console.log(pc.green("✓ Server reachable, token valid."));
      else if (p.kind === "unauthorized") console.log(pc.red("✗ Token rejected."));
      else console.log(pc.red("✗ Server unreachable."));
      return false;
    }
    case "live-status": {
      await showLiveStatus();
      await prompts({ type: "text", name: "_", message: "Press Enter to continue" }, cancelOpts);
      return false;
    }
    case "tail": {
      await tailLogs();
      return false;
    }
    case "change-server": {
      const partial = await loadPartialConfig();
      const newUrl = await promptServerUrl(partial?.serverUrl ?? "https://");
      const merged: PartialConfig = {
        serverUrl: newUrl,
        label: partial?.label ?? defaultLabel(),
        token: undefined,
        machineId: undefined,
        installedAt: partial?.installedAt,
      };
      await savePartialConfig(merged);
      console.log(pc.yellow("Server changed — token cleared. Run pair to re-authorize."));
      const ok = await confirm("Pair now?", true);
      if (ok) await runPairFlow(merged);
      return false;
    }
    case "change-label": {
      const partial = await loadPartialConfig();
      if (!partial) return false;
      const newLabel = await promptLabel(partial.label);
      await savePartialConfig({ ...partial, label: newLabel });
      console.log(pc.green(`✓ Label updated to "${newLabel}".`));
      console.log(pc.dim("(Existing token is unchanged. The server will treat this as the same machine until you re-pair.)"));
      return false;
    }
    case "retry":
      // Loop will re-detect on next iteration.
      return false;
    case "clear-pid":
      await clearStalePid();
      return false;
    case "autostart-on": {
      const ast = await getAutostartStatus();
      if (ast.platform === "unsupported") {
        console.log(pc.yellow("Auto-start is not supported on this platform yet."));
        return false;
      }
      const r = await enableAutostart();
      console.log(pc.green(`✓ Auto-start enabled via ${r.supervisor}.`));
      console.log(pc.dim("  Daemon is supervised — it will start on boot/login and respawn on crash."));
      return false;
    }
    case "autostart-off": {
      const ok = await confirm(
        "Disable auto-start? Daemon will not run on next reboot until you re-enable it.",
        false
      );
      if (!ok) return false;
      await disableAutostart();
      console.log(pc.green("✓ Auto-start disabled and daemon stopped."));
      return false;
    }
    case "uninstall": {
      const ok = await confirm(
        "This will stop the daemon and delete config + state. Continue?",
        false
      );
      if (!ok) return false;
      await disableAutostart().catch(() => undefined);
      await stopDaemon().catch(() => undefined);
      await deleteConfig();
      await unlink(STATE_PATH).catch(() => undefined);
      await unlink(QUEUE_PATH).catch(() => undefined);
      await unlink(PID_PATH).catch(() => undefined);
      console.log(pc.green("✓ Removed local config. Re-run cctm-agent to set up again."));
      return false;
    }
    default:
      return false;
  }
}

async function ensurePartialConfig(): Promise<PartialConfig | null> {
  const partial = await loadPartialConfig();
  if (partial) return partial;
  console.log(pc.red("No config — run Setup first."));
  return null;
}

async function maybeStartAfterSetup(_cfg: Config): Promise<void> {
  const ast = await getAutostartStatus();
  if (ast.platform !== "unsupported" && !ast.enabled) {
    const ok = await confirm(
      "Enable auto-start on boot? (recommended — keeps data uploads continuous)",
      true
    );
    if (ok) {
      try {
        const r = await enableAutostart();
        console.log(pc.green(`✓ Auto-start enabled via ${r.supervisor}; daemon is now running.`));
        return;
      } catch (err) {
        console.log(pc.yellow(`Could not enable auto-start: ${(err as Error).message}`));
        console.log(pc.dim("Falling back to one-time start."));
      }
    }
  }
  const ok = await confirm("Start daemon now?", true);
  if (!ok) return;
  const r = await startDaemon();
  console.log(pc.green(`✓ Daemon started (pid ${r.pid}).`));
  console.log(pc.dim(`  logs: ${r.logPath}`));
}

async function showStatus(): Promise<void> {
  console.log("");
  console.log(pc.bold("Configuration"));
  console.log(pc.dim(`  Path:        ${CONFIG_PATH}`));
  const cfg = await loadPartialConfig();
  if (!cfg) {
    console.log(pc.dim("  (no config)"));
    return;
  }
  console.log(pc.dim(`  Server:      ${cfg.serverUrl}`));
  console.log(pc.dim(`  Label:       ${cfg.label}`));
  console.log(pc.dim(`  Token:       ${maskToken(cfg.token)}`));
  if (cfg.machineId) console.log(pc.dim(`  Machine ID:  ${cfg.machineId}`));
  if (cfg.installedAt) console.log(pc.dim(`  Installed:   ${cfg.installedAt}`));

  console.log("");
  console.log(pc.bold("Files"));
  for (const p of [CONFIG_PATH, STATE_PATH, QUEUE_PATH, PID_PATH, LOG_DIR]) {
    const info = await fileInfo(p);
    console.log(pc.dim(`  ${p}  ${info}`));
  }
}

async function fileInfo(path: string): Promise<string> {
  try {
    const st = await stat(path);
    if (st.isDirectory()) return pc.dim("(dir)");
    const kb = (st.size / 1024).toFixed(1);
    return pc.dim(`(${kb} KiB, modified ${st.mtime.toISOString()})`);
  } catch {
    return pc.dim("(missing)");
  }
}

async function showLiveStatus(): Promise<void> {
  console.log("");
  console.log(pc.bold("Live status"));
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    const state = JSON.parse(raw) as { offsets?: Record<string, number> };
    const offsets = state.offsets ?? {};
    const sessionCount = Object.keys(offsets).length;
    const totalBytes = Object.values(offsets).reduce((a, b) => a + b, 0);
    console.log(pc.dim(`  Sessions tracked: ${sessionCount}`));
    console.log(pc.dim(`  Bytes consumed:   ${totalBytes}`));
  } catch {
    console.log(pc.dim("  (no state file yet)"));
  }
  try {
    const st = await stat(QUEUE_PATH);
    console.log(pc.dim(`  Failed-event queue: ${(st.size / 1024).toFixed(1)} KiB`));
  } catch {
    console.log(pc.dim("  Failed-event queue: empty"));
  }
}

async function tailLogs(): Promise<void> {
  const path = await latestLogPath();
  if (!path) {
    console.log(pc.yellow("No log file yet — start the daemon to generate logs."));
    return;
  }
  console.log(pc.dim(`Tailing ${path}  (Ctrl+C to stop)\n`));
  const child = spawn("tail", ["-n", "200", "-f", path], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    const onSig = (): void => {
      child.kill("SIGTERM");
    };
    process.once("SIGINT", onSig);
    child.on("exit", () => {
      process.off("SIGINT", onSig);
      resolve();
    });
  });
  console.log("");
}
