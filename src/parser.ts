import type { IngestEvent, ToolCall } from "@cctm/shared";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawContentItem {
  type: string;
  name?: string;
  input?: unknown;
}

interface RawMessage {
  model?: string;
  usage?: RawUsage;
  content?: RawContentItem[];
}

interface RawEntry {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: RawMessage;
  userType?: string;
  userEmail?: string;
}

/** Decode Claude Code's encoded project dir name back to an absolute path. */
export function decodeCwd(encoded: string): string {
  // Claude Code replaces "/" with "-" but does not escape original "-".
  // We can't perfectly invert, but assistant entries carry message-level cwd
  // for ground truth — this is only a fallback for fast project naming.
  if (encoded.startsWith("-")) return "/" + encoded.slice(1).replace(/-/g, "/");
  return encoded.replace(/-/g, "/");
}

function safeNum(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function extractToolCalls(content: RawContentItem[] | undefined): ToolCall[] | undefined {
  if (!content || !Array.isArray(content)) return undefined;
  const tools: ToolCall[] = [];
  for (const item of content) {
    if (item?.type === "tool_use" && typeof item.name === "string") {
      let bytes: number | undefined;
      try {
        bytes = JSON.stringify(item.input ?? null).length;
      } catch {
        bytes = undefined;
      }
      tools.push({ name: item.name, inputBytes: bytes });
    }
  }
  return tools.length ? tools : undefined;
}

export interface ParseContext {
  sessionUuid: string;
  cwd: string;
  claudeUserEmail?: string;
}

/**
 * Parse a single JSONL line. Returns null for non-assistant entries or
 * malformed lines.
 */
export function parseJsonlLine(
  line: string,
  ctx: ParseContext
): IngestEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let entry: RawEntry;
  try {
    entry = JSON.parse(trimmed) as RawEntry;
  } catch {
    return null;
  }
  if (entry.type !== "assistant") return null;
  if (!entry.timestamp || !entry.message) return null;

  const usage = entry.message.usage ?? {};
  const cwd = entry.cwd ?? ctx.cwd;
  const projectName = cwd.split("/").filter(Boolean).pop();

  return {
    sessionUuid: ctx.sessionUuid,
    cwd,
    projectName,
    timestamp: entry.timestamp,
    role: "assistant",
    model: entry.message.model,
    inputTokens: safeNum(usage.input_tokens),
    outputTokens: safeNum(usage.output_tokens),
    cacheCreationTokens: safeNum(usage.cache_creation_input_tokens),
    cacheReadTokens: safeNum(usage.cache_read_input_tokens),
    toolCalls: extractToolCalls(entry.message.content),
    claudeUserEmail: ctx.claudeUserEmail,
  };
}
