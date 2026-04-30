import os from "node:os";
import prompts from "prompts";
import pc from "picocolors";
import {
  loadPartialConfig,
  saveConfig,
  savePartialConfig,
  type Config,
  type PartialConfig,
} from "./config.js";
import {
  openBrowser,
  pollForToken,
  requestDeviceCode,
  type PollResult,
} from "./device-auth.js";

export function defaultLabel(): string {
  // Strip trailing ".local" / ".lan" so macOS "Dzs-Air.local" → "Dzs-Air".
  return os.hostname().replace(/\.(local|lan|home|internal)$/i, "");
}

export function detectOs(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

const onCancel = (): never => {
  console.log(pc.dim("\nCancelled."));
  process.exit(1);
};

export async function promptServerUrl(initial: string): Promise<string> {
  const r = await prompts(
    {
      type: "text",
      name: "serverUrl",
      message: "Server URL",
      initial,
      validate: (v: string) => /^https?:\/\//.test(v) || "Must start with http(s)://",
    },
    { onCancel }
  );
  return (r.serverUrl as string).trim().replace(/\/$/, "");
}

export async function promptLabel(initial: string): Promise<string> {
  const r = await prompts(
    {
      type: "text",
      name: "label",
      message: "Machine label",
      initial,
      validate: (v: string) => v.trim().length > 0 || "Required",
    },
    { onCancel }
  );
  return (r.label as string).trim();
}

export async function runSetupWizard(): Promise<Config | null> {
  const existing = await loadPartialConfig();
  const serverUrl = await promptServerUrl(existing?.serverUrl ?? "https://claude.dzapp.io.vn");
  const label = await promptLabel(existing?.label ?? defaultLabel());

  // Save partial config so we can resume pairing if user Ctrl+C's mid-flow.
  const partial: PartialConfig = {
    serverUrl,
    label,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
  };
  await savePartialConfig(partial);

  return runPairFlow(partial);
}

export async function runPairFlow(partial: PartialConfig): Promise<Config | null> {
  console.log(pc.dim(`\nRequesting pairing code from ${partial.serverUrl}…`));
  let code;
  try {
    code = await requestDeviceCode(partial.serverUrl, {
      os: detectOs(),
      label: partial.label,
    });
  } catch (err) {
    console.error(pc.red(`Failed to request device code: ${(err as Error).message}`));
    return null;
  }

  const completeUrl = code.verification_uri_complete;
  const baseUrl = code.verification_uri;

  console.log("");
  console.log(pc.bold("Open this URL to approve:"));
  console.log("  " + pc.cyan(completeUrl));
  console.log("");
  console.log(
    pc.dim(`Or visit `) +
      pc.cyan(baseUrl) +
      pc.dim(` and enter code: `) +
      pc.bold(code.user_code)
  );
  console.log(pc.dim(`Code expires in ${Math.round(code.expires_in / 60)} minute(s).`));
  console.log("");

  // Try to auto-open browser; ignore failure (URL is already printed).
  void openBrowser(completeUrl);

  const result = await pollWithSpinner(partial.serverUrl, code);

  switch (result.kind) {
    case "approved": {
      const cfg: Config = {
        serverUrl: partial.serverUrl,
        label: result.label || partial.label,
        token: result.token,
        machineId: result.machineId || undefined,
        installedAt: partial.installedAt ?? new Date().toISOString(),
      };
      await saveConfig(cfg);
      console.log(pc.green(`\n✓ Paired as "${cfg.label}".`));
      return cfg;
    }
    case "denied":
      console.log(pc.red("\n✗ Approval was denied."));
      return null;
    case "expired":
      console.log(pc.yellow("\n✗ Code expired. Try again."));
      return null;
    case "invalid":
      console.log(pc.red("\n✗ Pairing request was rejected by the server."));
      return null;
    case "network":
      console.log(pc.red(`\n✗ Network error: ${result.message}`));
      return null;
    case "pending":
      // Should not happen — pollForToken only returns pending mid-loop.
      console.log(pc.red("\n✗ Pairing did not complete in time."));
      return null;
  }
}

async function pollWithSpinner(
  serverUrl: string,
  code: { device_code: string; user_code: string; interval: number; expires_in: number; verification_uri: string; verification_uri_complete: string }
): Promise<PollResult> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIdx = 0;
  const start = Date.now();
  const tick = (): void => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const remaining = Math.max(0, code.expires_in - elapsed);
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    if (process.stdout.isTTY) {
      process.stdout.write(
        `\r${pc.cyan(frames[frameIdx])} Waiting for approval… (${min}:${String(sec).padStart(2, "0")} remaining)   `
      );
      frameIdx = (frameIdx + 1) % frames.length;
    }
  };
  tick();
  const spinner = setInterval(tick, 100);
  try {
    return await pollForToken(serverUrl, code);
  } finally {
    clearInterval(spinner);
    if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");
  }
}
