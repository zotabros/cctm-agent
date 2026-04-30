import { readFile, unlink } from "node:fs/promises";
import { loadPartialConfig, PID_PATH, type PartialConfig } from "./config.js";

export type AgentState =
  | { kind: "fresh" }
  | { kind: "partial"; config: PartialConfig }
  | { kind: "unreachable"; config: PartialConfig & { token: string } }
  | { kind: "unauthorized"; config: PartialConfig & { token: string } }
  | { kind: "idle"; config: PartialConfig & { token: string } }
  | { kind: "running"; config: PartialConfig & { token: string }; pid: number }
  | { kind: "stale-pid"; config: PartialConfig & { token: string }; pid: number };

export interface ProbeResult {
  kind: "ok" | "unauthorized" | "unreachable";
}

export interface StateDetectDeps {
  probe?: (serverUrl: string, token: string) => Promise<ProbeResult>;
  pidAlive?: (pid: number) => boolean;
  loadConfig?: () => Promise<PartialConfig | null>;
  readPid?: () => Promise<number | null>;
}

export async function probeServer(serverUrl: string, token: string): Promise<ProbeResult> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/ingest`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ machineLabel: "__probe__", events: [] }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
    return { kind: "ok" };
  } catch {
    return { kind: "unreachable" };
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

export async function readPidFile(): Promise<number | null> {
  try {
    const raw = await readFile(PID_PATH, "utf-8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function clearStalePid(): Promise<void> {
  await unlink(PID_PATH).catch(() => undefined);
}

export async function detectState(deps: StateDetectDeps = {}): Promise<AgentState> {
  const cfg = await (deps.loadConfig ?? loadPartialConfig)();
  if (!cfg) return { kind: "fresh" };
  if (!cfg.token) return { kind: "partial", config: cfg };

  const cfgWithToken = cfg as PartialConfig & { token: string };

  const pid = await (deps.readPid ?? readPidFile)();
  const aliveCheck = deps.pidAlive ?? isPidAlive;

  // probe server first (token validity / reachability)
  const probe = await (deps.probe ?? probeServer)(cfgWithToken.serverUrl, cfgWithToken.token);

  if (pid !== null) {
    if (aliveCheck(pid)) {
      if (probe.kind === "unauthorized") {
        return { kind: "unauthorized", config: cfgWithToken };
      }
      if (probe.kind === "unreachable") {
        return { kind: "unreachable", config: cfgWithToken };
      }
      return { kind: "running", config: cfgWithToken, pid };
    }
    return { kind: "stale-pid", config: cfgWithToken, pid };
  }

  if (probe.kind === "unauthorized") return { kind: "unauthorized", config: cfgWithToken };
  if (probe.kind === "unreachable") return { kind: "unreachable", config: cfgWithToken };
  return { kind: "idle", config: cfgWithToken };
}

export function describeState(s: AgentState): string {
  switch (s.kind) {
    case "fresh":
      return "Not configured";
    case "partial":
      return "Setup incomplete (no token)";
    case "unreachable":
      return "Server unreachable";
    case "unauthorized":
      return "Token rejected (revoked or expired)";
    case "idle":
      return "Configured, daemon stopped";
    case "running":
      return `Daemon running (pid ${s.pid})`;
    case "stale-pid":
      return "Stale PID file";
  }
}

