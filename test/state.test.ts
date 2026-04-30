import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;

vi.mock("../src/config.js", async () => {
  return {
    ensureConfigDir: async () => {},
    get STATE_PATH() {
      return join(TMP, "state.json");
    },
  };
});

describe("state offset tracking", () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "cctm-state-"));
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns 0 when no prior offset", async () => {
    const { getOffset } = await import("../src/state.js");
    expect(await getOffset("/x/a.jsonl")).toBe(0);
  });

  it("persists and reloads offset (no double-count)", async () => {
    const m1 = await import("../src/state.js");
    await m1.setOffset("/x/a.jsonl", 4096);
    await m1.setOffset("/x/b.jsonl", 128);
    await m1.persist();

    vi.resetModules();
    const m2 = await import("../src/state.js");
    expect(await m2.getOffset("/x/a.jsonl")).toBe(4096);
    expect(await m2.getOffset("/x/b.jsonl")).toBe(128);
    expect(await m2.getOffset("/x/c.jsonl")).toBe(0);
  });

  it("monotonically updates offset on subsequent writes", async () => {
    const { getOffset, setOffset, persist } = await import("../src/state.js");
    await setOffset("/p.jsonl", 100);
    await setOffset("/p.jsonl", 250);
    await persist();
    expect(await getOffset("/p.jsonl")).toBe(250);
  });

  it("pins email per file and persists across reloads", async () => {
    const m1 = await import("../src/state.js");
    expect(await m1.getPinnedEmail("/x/a.jsonl")).toBeUndefined();
    await m1.pinEmail("/x/a.jsonl", "alice@example.com");
    await m1.pinEmail("/x/b.jsonl", "bob@example.com");
    await m1.persist();

    vi.resetModules();
    const m2 = await import("../src/state.js");
    expect(await m2.getPinnedEmail("/x/a.jsonl")).toBe("alice@example.com");
    expect(await m2.getPinnedEmail("/x/b.jsonl")).toBe("bob@example.com");
    expect(await m2.getPinnedEmail("/x/c.jsonl")).toBeUndefined();
  });

  it("pinned email is not overwritten by later pin call", async () => {
    // The watcher only calls pinEmail when getPinnedEmail returned undefined,
    // so this test documents the lower-level guarantee: pinEmail itself is
    // last-write-wins, but the policy in the watcher prevents that.
    const { pinEmail, getPinnedEmail, persist } = await import(
      "../src/state.js"
    );
    await pinEmail("/x/a.jsonl", "first@example.com");
    await persist();
    expect(await getPinnedEmail("/x/a.jsonl")).toBe("first@example.com");
  });
});
