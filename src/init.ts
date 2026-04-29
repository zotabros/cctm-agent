import prompts from "prompts";
import pc from "picocolors";
import { loadConfig, saveConfig, type Config } from "./config.js";

interface InitOptions {
  server?: string;
  token?: string;
  label?: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const existing = await loadConfig();
  if (existing) {
    console.log(pc.yellow("A config already exists; values will be overwritten."));
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
        initial: existing?.label,
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
