import os from "node:os";
import prompts from "prompts";
import pc from "picocolors";
import { loadConfig, saveConfig, type Config } from "./config.js";

function defaultLabel(): string {
  // Strip trailing ".local" / ".lan" so macOS "Dzs-Air.local" → "Dzs-Air".
  return os.hostname().replace(/\.(local|lan|home|internal)$/i, "");
}

interface InitOptions {
  server?: string;
  token?: string;
  label?: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const loaded = await loadConfig();
  let existing: Config | null = loaded;
  if (loaded) {
    console.log(pc.yellow("A config already exists."));
    console.log(pc.dim(`  Server: ${loaded.serverUrl}`));
    console.log(pc.dim(`  Label:  ${loaded.label}`));
    console.log(pc.dim(`  Token:  ${loaded.token ? "(set)" : "(empty)"}`));
    const noFlags = !opts.server && !opts.label && !opts.token;
    if (noFlags) {
      const { mode } = await prompts(
        {
          type: "select",
          name: "mode",
          message: "What would you like to do?",
          choices: [
            { title: "Keep existing config (exit)", value: "keep" },
            { title: "Update some values (current values pre-filled)", value: "update" },
            { title: "Start fresh (clear all and re-enter)", value: "fresh" },
          ],
          initial: 0,
        },
        { onCancel: () => process.exit(1) }
      );
      if (mode === "keep") {
        console.log(pc.green("No changes."));
        return;
      }
      if (mode === "fresh") {
        existing = null;
      }
    }
  }

  const hasExistingToken = !!existing?.token;
  const responses = await prompts(
    [
      {
        type: opts.server ? null : "text",
        name: "serverUrl",
        message: "Server URL",
        initial: existing?.serverUrl ?? "https://claude.dzapp.io.vn",
        validate: (v: string) => /^https?:\/\//.test(v) || "Must start with http(s)://",
      },
      {
        type: opts.label ? null : "text",
        name: "label",
        message: "Machine label",
        initial: existing?.label ?? defaultLabel(),
        validate: (v: string) => v.length > 0 || "Required",
      },
      {
        type: opts.token || !hasExistingToken ? null : "confirm",
        name: "replaceToken",
        message: "Replace existing machine token?",
        initial: false,
      },
      {
        type: (_prev, values) => {
          if (opts.token) return null;
          if (!hasExistingToken) return "password";
          return values.replaceToken ? "password" : null;
        },
        name: "token",
        message: "Machine token (paste from dashboard)",
        validate: (v: string) => v.length >= 8 || "Token too short",
      },
    ],
    { onCancel: () => process.exit(1) }
  );

  const cfg: Config = {
    serverUrl: opts.server ?? (responses.serverUrl as string),
    label: opts.label ?? (responses.label as string),
    token: opts.token ?? (responses.token as string) ?? existing?.token ?? "",
  };
  await saveConfig(cfg);
  console.log(pc.green(`Saved config. Run "cctm-collect run" to start the agent.`));
}
