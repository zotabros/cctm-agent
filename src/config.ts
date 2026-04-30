import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { z } from "zod";

const ConfigSchema = z.object({
  serverUrl: z.string().url(),
  token: z.string().min(8),
  label: z.string().min(1),
  machineId: z.string().optional(),
  installedAt: z.string().optional(),
});

const PartialConfigSchema = z.object({
  serverUrl: z.string().url(),
  label: z.string().min(1),
  token: z.string().optional(),
  machineId: z.string().optional(),
  installedAt: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PartialConfig = z.infer<typeof PartialConfigSchema>;

export const CONFIG_DIR = join(homedir(), ".config", "cctm");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STATE_PATH = join(CONFIG_DIR, "state.json");
export const QUEUE_PATH = join(CONFIG_DIR, "queue.jsonl");
export const PID_PATH = join(CONFIG_DIR, "agent.pid");
export const LOG_DIR = join(CONFIG_DIR, "logs");
export const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
export const CLAUDE_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");
export const CLAUDE_CONFIG = join(homedir(), ".claude.json");

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function loadPartialConfig(): Promise<PartialConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return PartialConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export async function savePartialConfig(cfg: PartialConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export async function deleteConfig(): Promise<void> {
  await unlink(CONFIG_PATH).catch(() => undefined);
}
