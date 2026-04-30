import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenSuccess {
  kind: "approved";
  token: string;
  machineId: string;
  label: string;
}

export type PollResult =
  | TokenSuccess
  | { kind: "pending" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "network"; status: number; message: string };

interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    ok: boolean;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface DeviceAuthDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openBrowser?: (url: string) => Promise<boolean>;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

const defaultFetch: FetchLike = (input, init) =>
  fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function requestDeviceCode(
  serverUrl: string,
  body: { os: string; label?: string },
  deps: DeviceAuthDeps = {}
): Promise<DeviceCodeResponse> {
  const f = deps.fetchImpl ?? defaultFetch;
  const url = `${serverUrl.replace(/\/$/, "")}/api/devices/code`;
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`device_code_failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as DeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("device_code_malformed");
  }
  return json;
}

export async function pollOnce(
  serverUrl: string,
  deviceCode: string,
  deps: DeviceAuthDeps = {}
): Promise<PollResult> {
  const f = deps.fetchImpl ?? defaultFetch;
  const url = `${serverUrl.replace(/\/$/, "")}/api/devices/token`;
  let res;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
  } catch (err) {
    return { kind: "network", status: 0, message: (err as Error).message };
  }

  if (res.status === 200) {
    const json = (await res.json()) as { token?: string; machineId?: string; label?: string };
    if (!json.token) return { kind: "invalid" };
    return {
      kind: "approved",
      token: json.token,
      machineId: json.machineId ?? "",
      label: json.label ?? "",
    };
  }
  if (res.status === 425) return { kind: "pending" };
  if (res.status === 403) return { kind: "denied" };
  if (res.status === 410) return { kind: "expired" };
  if (res.status === 404) return { kind: "invalid" };
  const txt = await res.text().catch(() => "");
  return { kind: "network", status: res.status, message: txt.slice(0, 200) };
}

export async function pollForToken(
  serverUrl: string,
  code: DeviceCodeResponse,
  deps: DeviceAuthDeps = {}
): Promise<PollResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const intervalMs = Math.max(1, code.interval) * 1000;
  const deadline = now() + Math.max(30, code.expires_in) * 1000;

  let consecutiveNetworkErrors = 0;
  while (now() < deadline) {
    if (deps.signal?.aborted) return { kind: "invalid" };
    const result = await pollOnce(serverUrl, code.device_code, deps);
    if (result.kind === "approved") return result;
    if (result.kind === "denied" || result.kind === "expired") return result;
    if (result.kind === "invalid") return result;
    if (result.kind === "network") {
      consecutiveNetworkErrors++;
      log(`network error (attempt ${consecutiveNetworkErrors}): ${result.message}`);
      if (consecutiveNetworkErrors >= 3) return result;
    } else {
      consecutiveNetworkErrors = 0;
    }
    await sleep(intervalMs);
  }
  return { kind: "expired" };
}

export async function openBrowser(url: string): Promise<boolean> {
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === "darwin") {
    cmd = "open";
    args = [url];
  } else if (p === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = "xdg-open";
    args = [url];
  }
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      child.unref();
      setTimeout(() => resolve(true), 500);
    } catch {
      resolve(false);
    }
  });
}
