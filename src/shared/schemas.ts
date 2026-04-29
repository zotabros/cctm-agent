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
