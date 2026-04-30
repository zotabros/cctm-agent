import { z } from "zod";

export const ToolCallSchema = z.object({
  name: z.string().min(1).max(128),
  inputBytes: z.number().int().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
});

export const IngestEventSchema = z.object({
  sessionUuid: z.string().min(1).max(128),
  cwd: z.string().min(1).max(2048),
  projectName: z.string().min(1).max(256).optional(),
  timestamp: z.string().datetime(),
  role: z.enum(["assistant", "user"]),
  model: z.string().min(1).max(128).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  toolCalls: z.array(ToolCallSchema).max(64).optional(),
  claudeUserEmail: z.string().email().optional(),
});

export const IngestBatchSchema = z.object({
  machineLabel: z.string().min(1).max(128).optional(),
  events: z.array(IngestEventSchema).min(0).max(1000),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type IngestEvent = z.infer<typeof IngestEventSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

// ---------------- Advisor Inventory ----------------
// Snapshot of the local Claude Code configuration. Metadata only — never send
// file bodies, env values, or secrets.

export const InventoryPluginSchema = z.object({
  name: z.string().min(1).max(256),
  source: z.string().max(256).optional(),
  version: z.string().max(64).optional(),
  scope: z.enum(["user", "project"]).optional(),
  enabled: z.boolean().optional(),
  installedAt: z.string().datetime().optional(),
  projectPath: z.string().max(2048).optional(),
});

export const InventorySkillSchema = z.object({
  name: z.string().min(1).max(256),
  origin: z.enum(["user", "plugin", "project"]),
  pluginName: z.string().max(256).optional(),
  bodyBytes: z.number().int().nonnegative(),
  descriptionBytes: z.number().int().nonnegative().optional(),
});

export const InventoryAgentSchema = z.object({
  name: z.string().min(1).max(256),
  origin: z.enum(["user", "plugin", "project"]),
  pluginName: z.string().max(256).optional(),
  bodyBytes: z.number().int().nonnegative(),
});

export const InventoryMcpServerSchema = z.object({
  name: z.string().min(1).max(256),
  origin: z.enum(["user", "plugin", "project", "remote"]),
  transport: z.enum(["stdio", "http", "sse", "unknown"]).optional(),
  command: z.string().max(512).optional(), // stdio command name only, no args/env values
  pluginName: z.string().max(256).optional(),
});

export const InventoryHookSchema = z.object({
  event: z.string().min(1).max(64),
  matcher: z.string().max(256).optional(),
  commandPreview: z.string().max(160), // first 160 chars only
  commandHash: z.string().max(32),     // sha256 first 12 hex of full command
});

export const InventoryClaudeMdSchema = z.object({
  scope: z.enum(["global", "project"]),
  bytes: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
});

export const InventoryPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime(),
  os: z.string().max(64).optional(),
  agentVersion: z.string().max(64).optional(),
  plugins: z.array(InventoryPluginSchema).max(256),
  skills: z.array(InventorySkillSchema).max(512),
  agents: z.array(InventoryAgentSchema).max(512),
  mcpServers: z.array(InventoryMcpServerSchema).max(128),
  hooks: z.array(InventoryHookSchema).max(256),
  claudeMd: z.array(InventoryClaudeMdSchema).max(64),
  commands: z.array(z.string().max(128)).max(256),
  settingsBytes: z.number().int().nonnegative().optional(),
});

export type InventoryPayload = z.infer<typeof InventoryPayloadSchema>;
export type InventoryPlugin = z.infer<typeof InventoryPluginSchema>;
export type InventorySkill = z.infer<typeof InventorySkillSchema>;
export type InventoryAgent = z.infer<typeof InventoryAgentSchema>;
export type InventoryMcpServer = z.infer<typeof InventoryMcpServerSchema>;
export type InventoryHook = z.infer<typeof InventoryHookSchema>;
