import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";

export type AutostartPlatform = "macos" | "linux" | "unsupported";

export interface AutostartStatus {
  platform: AutostartPlatform;
  unitPath: string | null;
  enabled: boolean;
}

const LAUNCHD_LABEL = "com.cctm.agent";

function detectPlatform(): AutostartPlatform {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unsupported";
  }
}

function unitPathFor(p: AutostartPlatform): string | null {
  if (p === "macos") return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (p === "linux") return join(homedir(), ".config", "systemd", "user", "cctm-agent.service");
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function getAutostartStatus(): Promise<AutostartStatus> {
  const p = detectPlatform();
  const unit = unitPathFor(p);
  if (!unit) return { platform: p, unitPath: null, enabled: false };
  const enabled = await fileExists(unit);
  return { platform: p, unitPath: unit, enabled };
}

function entryArgs(): { node: string; entry: string } {
  return { node: process.execPath, entry: process.argv[1] };
}

function plistContent(): string {
  const { node, entry } = entryArgs();
  const home = homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${home}/.config/cctm/logs/launchd-out.log</string>
  <key>StandardErrorPath</key><string>${home}/.config/cctm/logs/launchd-err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${home}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>CCTM_DAEMON</key><string>1</string>
  </dict>
</dict>
</plist>
`;
}

function systemdContent(): string {
  const { node, entry } = entryArgs();
  const home = homedir();
  return `[Unit]
Description=CCTokenManager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=${home}
Environment=CCTM_DAEMON=1
ExecStart=${node} ${entry} --daemon
Restart=on-failure
RestartSec=5
StandardOutput=append:${home}/.config/cctm/logs/systemd-out.log
StandardError=append:${home}/.config/cctm/logs/systemd-err.log

[Install]
WantedBy=default.target
`;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve({ ok: false, code: null, stderr: "spawn_failed" }));
    child.on("exit", (code) => resolve({ ok: code === 0, code, stderr }));
  });
}

export async function enableAutostart(): Promise<{ supervisor: string }> {
  const status = await getAutostartStatus();
  if (status.platform === "unsupported" || !status.unitPath) {
    throw new Error("autostart_unsupported_platform");
  }
  await mkdir(join(homedir(), ".config", "cctm", "logs"), { recursive: true });

  if (status.platform === "macos") {
    await writeFile(status.unitPath, plistContent(), "utf-8");
    // Reload to pick up changes if it was already loaded.
    await run("launchctl", ["unload", status.unitPath]);
    const r = await run("launchctl", ["load", "-w", status.unitPath]);
    if (!r.ok) throw new Error(`launchctl load failed: ${r.stderr.trim()}`);
    return { supervisor: "launchd" };
  }

  // linux
  await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  await writeFile(status.unitPath, systemdContent(), "utf-8");
  await run("systemctl", ["--user", "daemon-reload"]);
  const r = await run("systemctl", ["--user", "enable", "--now", "cctm-agent.service"]);
  if (!r.ok) throw new Error(`systemctl enable failed: ${r.stderr.trim()}`);
  return { supervisor: "systemd" };
}

export async function disableAutostart(): Promise<void> {
  const status = await getAutostartStatus();
  if (!status.enabled || !status.unitPath || status.platform === "unsupported") return;

  if (status.platform === "macos") {
    await run("launchctl", ["unload", "-w", status.unitPath]);
    await unlink(status.unitPath).catch(() => undefined);
    return;
  }
  await run("systemctl", ["--user", "disable", "--now", "cctm-agent.service"]);
  await unlink(status.unitPath).catch(() => undefined);
  await run("systemctl", ["--user", "daemon-reload"]);
}

export async function startViaSupervisor(): Promise<void> {
  const status = await getAutostartStatus();
  if (!status.enabled) throw new Error("autostart_not_enabled");
  if (status.platform === "macos") {
    const r = await run("launchctl", ["kickstart", `gui/${process.getuid?.() ?? ""}/${LAUNCHD_LABEL}`]);
    if (!r.ok) {
      // Older macOS: try load.
      if (status.unitPath) await run("launchctl", ["load", "-w", status.unitPath]);
    }
    return;
  }
  const r = await run("systemctl", ["--user", "start", "cctm-agent.service"]);
  if (!r.ok) throw new Error(`systemctl start failed: ${r.stderr.trim()}`);
}

export async function stopViaSupervisor(): Promise<void> {
  const status = await getAutostartStatus();
  if (!status.enabled) throw new Error("autostart_not_enabled");
  if (status.platform === "macos") {
    const uid = process.getuid?.();
    if (uid !== undefined) {
      await run("launchctl", ["kill", "SIGTERM", `gui/${uid}/${LAUNCHD_LABEL}`]);
    }
    // KeepAlive=true means launchd will respawn — full stop requires unload.
    if (status.unitPath) await run("launchctl", ["unload", status.unitPath]);
    return;
  }
  const r = await run("systemctl", ["--user", "stop", "cctm-agent.service"]);
  if (!r.ok) throw new Error(`systemctl stop failed: ${r.stderr.trim()}`);
}

export async function restartViaSupervisor(): Promise<void> {
  const status = await getAutostartStatus();
  if (!status.enabled) throw new Error("autostart_not_enabled");
  if (status.platform === "macos") {
    const uid = process.getuid?.();
    const target = `gui/${uid ?? ""}/${LAUNCHD_LABEL}`;
    const r = await run("launchctl", ["kickstart", "-k", target]);
    if (!r.ok && status.unitPath) {
      await run("launchctl", ["unload", status.unitPath]);
      await run("launchctl", ["load", "-w", status.unitPath]);
    }
    return;
  }
  const r = await run("systemctl", ["--user", "restart", "cctm-agent.service"]);
  if (!r.ok) throw new Error(`systemctl restart failed: ${r.stderr.trim()}`);
}

export function describeAutostart(s: AutostartStatus): string {
  if (s.platform === "unsupported") return "auto-start: not supported on this platform";
  if (s.enabled) return `auto-start: enabled (${s.platform === "macos" ? "launchd" : "systemd"})`;
  return "auto-start: disabled";
}
