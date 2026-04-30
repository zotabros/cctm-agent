import { homedir, platform } from "node:os";
import { join, basename, dirname, relative } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  InventoryPayload,
  InventoryPlugin,
  InventorySkill,
  InventoryAgent,
  InventoryMcpServer,
  InventoryHook,
} from "./shared/schemas.js";
import { BUILD_INFO } from "./buildinfo.js";

const CLAUDE_HOME = join(homedir(), ".claude");

async function safeStat(p: string): Promise<{ size: number; lines: number } | null> {
  try {
    const st = await stat(p);
    if (!st.isFile()) return null;
    const buf = await readFile(p, "utf-8");
    return { size: st.size, lines: buf.split("\n").length };
  } catch {
    return null;
  }
}

async function readJsonSafe<T = unknown>(p: string): Promise<T | null> {
  try {
    const buf = await readFile(p, "utf-8");
    return JSON.parse(buf) as T;
  } catch {
    return null;
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

function commandHash(cmd: string): string {
  return createHash("sha256").update(cmd).digest("hex").slice(0, 12);
}

interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, Array<{
    scope?: string;
    projectPath?: string;
    version?: string;
    installedAt?: string;
    lastUpdated?: string;
    installPath?: string;
  }>>;
}

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
  hooks?: Record<string, Array<{
    matcher?: string;
    hooks?: Array<{ command?: string }>;
  }>>;
  mcpServers?: Record<string, { command?: string; type?: string; url?: string }>;
}

async function collectPlugins(enabledMap: Record<string, boolean>): Promise<InventoryPlugin[]> {
  const file = await readJsonSafe<InstalledPluginsFile>(join(CLAUDE_HOME, "plugins", "installed_plugins.json"));
  const out: InventoryPlugin[] = [];
  if (!file?.plugins) return out;
  for (const [name, installs] of Object.entries(file.plugins)) {
    for (const inst of installs) {
      out.push({
        name,
        source: name.includes("@") ? name.split("@")[1] : undefined,
        version: inst.version && inst.version !== "unknown" ? inst.version : undefined,
        scope: inst.scope === "project" ? "project" : "user",
        enabled: !!enabledMap[name],
        installedAt: inst.installedAt,
        projectPath: inst.projectPath,
      });
    }
  }
  return out;
}

async function readSkillMeta(skillPath: string): Promise<{ bodyBytes: number; descriptionBytes: number } | null> {
  const meta = await safeStat(skillPath);
  if (!meta) return null;
  const buf = await readFile(skillPath, "utf-8").catch(() => "");
  // Front-matter description block
  let descriptionBytes = 0;
  const fm = /^---\s*\n([\s\S]*?)\n---/m.exec(buf);
  if (fm) {
    const m = /description:\s*([\s\S]*?)(?:\n[a-zA-Z_]+:|\n---|$)/.exec(fm[1]);
    if (m) descriptionBytes = m[1].trim().length;
  }
  return { bodyBytes: meta.size, descriptionBytes };
}

async function collectSkills(): Promise<InventorySkill[]> {
  const out: InventorySkill[] = [];
  // User skills
  for (const name of await listDir(join(CLAUDE_HOME, "skills"))) {
    const skillFile = join(CLAUDE_HOME, "skills", name, "SKILL.md");
    const m = await readSkillMeta(skillFile);
    if (m) out.push({ name, origin: "user", bodyBytes: m.bodyBytes, descriptionBytes: m.descriptionBytes });
  }
  // Plugin skills
  const pluginsCache = join(CLAUDE_HOME, "plugins", "cache");
  await walkSkills(pluginsCache, out);
  return out;
}

async function walkSkills(root: string, out: InventorySkill[], depth = 0): Promise<void> {
  if (depth > 6) return;
  const entries = await listDir(root);
  for (const e of entries) {
    const p = join(root, e);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    if (st.isFile() && e === "SKILL.md") {
      const m = await readSkillMeta(p);
      if (m) {
        // Determine plugin name from path: cache/<source>/<plugin>/<version>/...
        const rel = relative(join(CLAUDE_HOME, "plugins", "cache"), p).split("/");
        const pluginName = rel.length >= 2 ? `${rel[1]}@${rel[0]}` : undefined;
        out.push({
          name: basename(dirname(p)),
          origin: "plugin",
          pluginName,
          bodyBytes: m.bodyBytes,
          descriptionBytes: m.descriptionBytes,
        });
      }
    } else if (st.isDirectory()) {
      await walkSkills(p, out, depth + 1);
    }
  }
}

async function collectAgents(): Promise<InventoryAgent[]> {
  const out: InventoryAgent[] = [];
  for (const f of await listDir(join(CLAUDE_HOME, "agents"))) {
    if (!f.endsWith(".md")) continue;
    const meta = await safeStat(join(CLAUDE_HOME, "agents", f));
    if (meta) out.push({ name: f.replace(/\.md$/, ""), origin: "user", bodyBytes: meta.size });
  }
  return out;
}

async function collectMcpServers(settings: SettingsFile | null): Promise<InventoryMcpServer[]> {
  const out: InventoryMcpServer[] = [];
  // From settings.json
  for (const [name, cfg] of Object.entries(settings?.mcpServers ?? {})) {
    const transport = cfg.type === "http" ? "http" : cfg.type === "sse" ? "sse" : cfg.command ? "stdio" : "unknown";
    out.push({
      name,
      origin: "user",
      transport: transport as "stdio" | "http" | "sse" | "unknown",
      command: cfg.command,
    });
  }
  // From plugin .mcp.json files
  const pluginsCache = join(CLAUDE_HOME, "plugins", "cache");
  await walkMcp(pluginsCache, out);
  return out;
}

async function walkMcp(root: string, out: InventoryMcpServer[], depth = 0): Promise<void> {
  if (depth > 6) return;
  for (const e of await listDir(root)) {
    const p = join(root, e);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    if (st.isFile() && (e === ".mcp.json" || e === "mcp.json")) {
      const data = await readJsonSafe<Record<string, unknown>>(p);
      if (!data) continue;
      const servers = (data.mcpServers && typeof data.mcpServers === "object") ? data.mcpServers as Record<string, { command?: string; type?: string }> : data as Record<string, { command?: string; type?: string }>;
      const rel = relative(join(CLAUDE_HOME, "plugins", "cache"), p).split("/");
      const pluginName = rel.length >= 2 ? `${rel[1]}@${rel[0]}` : undefined;
      for (const [name, cfg] of Object.entries(servers)) {
        if (typeof cfg !== "object" || cfg === null) continue;
        const transport = (cfg.type === "http" || cfg.type === "sse") ? cfg.type : cfg.command ? "stdio" : "unknown";
        out.push({
          name,
          origin: "plugin",
          transport: transport as "stdio" | "http" | "sse" | "unknown",
          command: cfg.command ? basename(cfg.command) : undefined,
          pluginName,
        });
      }
    } else if (st.isDirectory()) {
      await walkMcp(p, out, depth + 1);
    }
  }
}

function collectHooks(settings: SettingsFile | null): InventoryHook[] {
  const out: InventoryHook[] = [];
  for (const [event, entries] of Object.entries(settings?.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        const cmd = h.command ?? "";
        out.push({
          event,
          matcher: entry.matcher,
          commandPreview: cmd.slice(0, 160),
          commandHash: commandHash(cmd),
        });
      }
    }
  }
  return out;
}

async function collectClaudeMd(): Promise<InventoryPayload["claudeMd"]> {
  const global = await safeStat(join(CLAUDE_HOME, "CLAUDE.md"));
  const out: InventoryPayload["claudeMd"] = [];
  if (global) out.push({ scope: "global", bytes: global.size, lines: global.lines });
  return out;
}

async function collectCommands(): Promise<string[]> {
  return (await listDir(join(CLAUDE_HOME, "commands"))).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}

export async function collectInventory(): Promise<InventoryPayload> {
  const settings = await readJsonSafe<SettingsFile>(join(CLAUDE_HOME, "settings.json"));
  const settingsBytes = (await safeStat(join(CLAUDE_HOME, "settings.json")))?.size ?? 0;
  const enabledMap = settings?.enabledPlugins ?? {};

  const [plugins, skills, agents, mcpServers, claudeMd, commands] = await Promise.all([
    collectPlugins(enabledMap),
    collectSkills(),
    collectAgents(),
    collectMcpServers(settings),
    collectClaudeMd(),
    collectCommands(),
  ]);
  const hooks = collectHooks(settings);

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    os: platform(),
    agentVersion: BUILD_INFO.version,
    plugins,
    skills,
    agents,
    mcpServers,
    hooks,
    claudeMd,
    commands,
    settingsBytes,
  };
}

export async function uploadInventory(serverUrl: string, token: string): Promise<{ ok: boolean; status: number; body: string }> {
  const payload = await collectInventory();
  const url = `${serverUrl.replace(/\/$/, "")}/api/inventory`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
