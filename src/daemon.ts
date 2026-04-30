import { spawn } from "node:child_process";
import { open, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureConfigDir, ensureLogDir, LOG_DIR, PID_PATH } from "./config.js";
import { isPidAlive, readPidFile } from "./state-detect.js";
import {
  getAutostartStatus,
  startViaSupervisor,
  stopViaSupervisor,
  restartViaSupervisor,
} from "./autostart.js";

function todaysLogPath(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return join(LOG_DIR, `agent-${yyyy}-${mm}-${dd}.log`);
}

export async function latestLogPath(): Promise<string | null> {
  const candidate = todaysLogPath();
  try {
    await stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export interface StartDaemonResult {
  pid: number;
  logPath: string;
}

export async function startDaemon(): Promise<StartDaemonResult> {
  const autostart = await getAutostartStatus();
  if (autostart.enabled) {
    await startViaSupervisor();
    // Wait briefly for the daemon (under launchd/systemd supervision) to write its PID.
    for (let i = 0; i < 25; i++) {
      const pid = await readPidFile();
      if (pid !== null && isPidAlive(pid)) {
        return { pid, logPath: todaysLogPath() };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { pid: 0, logPath: todaysLogPath() };
  }

  const existing = await readPidFile();
  if (existing && isPidAlive(existing)) {
    throw new Error(`already_running:${existing}`);
  }

  await ensureConfigDir();
  await ensureLogDir();
  const logPath = todaysLogPath();
  const fh = await open(logPath, "a");
  const fd = fh.fd;

  const node = process.execPath;
  const entry = process.argv[1];
  const child = spawn(node, [entry, "--daemon"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, CCTM_DAEMON: "1" },
  });

  if (typeof child.pid !== "number") {
    await fh.close();
    throw new Error("spawn_failed");
  }
  await writeFile(PID_PATH, String(child.pid), "utf-8");
  child.unref();
  // Close our copy of the fd; the child has its own duplicate.
  await fh.close();
  return { pid: child.pid, logPath };
}

export async function stopDaemon(): Promise<{ stopped: boolean; pid: number | null }> {
  const autostart = await getAutostartStatus();
  if (autostart.enabled) {
    const pidBefore = await readPidFile();
    await stopViaSupervisor();
    await unlink(PID_PATH).catch(() => undefined);
    return { stopped: true, pid: pidBefore };
  }

  const pid = await readPidFile();
  if (pid === null) return { stopped: false, pid: null };
  if (!isPidAlive(pid)) {
    await unlink(PID_PATH).catch(() => undefined);
    return { stopped: false, pid };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 25; i++) {
    if (!isPidAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await unlink(PID_PATH).catch(() => undefined);
  return { stopped: true, pid };
}

export async function restartDaemon(): Promise<StartDaemonResult> {
  const autostart = await getAutostartStatus();
  if (autostart.enabled) {
    await restartViaSupervisor();
    for (let i = 0; i < 25; i++) {
      const pid = await readPidFile();
      if (pid !== null && isPidAlive(pid)) {
        return { pid, logPath: todaysLogPath() };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { pid: 0, logPath: todaysLogPath() };
  }
  await stopDaemon();
  return startDaemon();
}
