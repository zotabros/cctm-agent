import { describe, it, expect } from "vitest";
import { parseJsonlLine, decodeCwd } from "../src/parser.js";

const CTX = { sessionUuid: "sess-uuid-1", cwd: "/tmp/ctx" };

describe("decodeCwd", () => {
  it("converts leading dash to slash and replaces inner dashes", () => {
    expect(decodeCwd("-Volumes-Dev-www-foo")).toBe("/Volumes/Dev/www/foo");
  });

  it("handles non-leading-dash input", () => {
    expect(decodeCwd("home-user-code")).toBe("home/user/code");
  });
});

describe("parseJsonlLine", () => {
  it("returns null for blank line", () => {
    expect(parseJsonlLine("", CTX)).toBeNull();
    expect(parseJsonlLine("   ", CTX)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseJsonlLine("not json", CTX)).toBeNull();
  });

  it("returns null for user entries", () => {
    const line = JSON.stringify({ type: "user", timestamp: "2026-04-29T10:00:00.000Z", message: { content: "hi" } });
    expect(parseJsonlLine(line, CTX)).toBeNull();
  });

  it("returns null when assistant entry lacks timestamp/message", () => {
    expect(parseJsonlLine(JSON.stringify({ type: "assistant" }), CTX)).toBeNull();
  });

  it("parses assistant entry with usage and model", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-29T10:01:00.000Z",
      cwd: "/Users/dz/code",
      sessionId: "ignored",
      message: {
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
        content: [{ type: "text", text: "hello" }],
      },
    });
    const ev = parseJsonlLine(line, CTX);
    expect(ev).not.toBeNull();
    expect(ev!.role).toBe("assistant");
    expect(ev!.model).toBe("claude-opus-4-7");
    expect(ev!.timestamp).toBe("2026-04-29T10:01:00.000Z");
    expect(ev!.cwd).toBe("/Users/dz/code");
    expect(ev!.projectName).toBe("code");
    expect(ev!.inputTokens).toBe(1234);
    expect(ev!.outputTokens).toBe(567);
    expect(ev!.cacheCreationTokens).toBe(100);
    expect(ev!.cacheReadTokens).toBe(8000);
    expect(ev!.sessionUuid).toBe(CTX.sessionUuid);
    expect(ev!.toolCalls).toBeUndefined();
  });

  it("extracts tool calls with inputBytes", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-29T10:02:00.000Z",
      cwd: "/x",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "tool_use", name: "Bash", input: { cmd: "ls" } },
          { type: "tool_use", name: "Read", input: { file_path: "/a/b" } },
          { type: "text", text: "hi" },
        ],
      },
    });
    const ev = parseJsonlLine(line, CTX)!;
    expect(ev.toolCalls).toHaveLength(2);
    expect(ev.toolCalls!.map((t) => t.name).sort()).toEqual(["Bash", "Read"]);
    for (const t of ev.toolCalls!) expect(t.inputBytes).toBeGreaterThan(0);
  });

  it("uses ctx.cwd fallback when entry has no cwd", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-29T10:03:00.000Z",
      message: { model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 5 } },
    });
    const ev = parseJsonlLine(line, { ...CTX, cwd: "/fallback/path" })!;
    expect(ev.cwd).toBe("/fallback/path");
    expect(ev.projectName).toBe("path");
  });

  it("treats negative / non-finite usage as 0", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-29T10:04:00.000Z",
      cwd: "/x",
      message: {
        model: "claude-opus-4-7",
        usage: { input_tokens: -10, output_tokens: Number.NaN, cache_read_input_tokens: 50 },
      },
    });
    const ev = parseJsonlLine(line, CTX)!;
    expect(ev.inputTokens).toBe(0);
    expect(ev.outputTokens).toBe(0);
    expect(ev.cacheReadTokens).toBe(50);
  });
});
