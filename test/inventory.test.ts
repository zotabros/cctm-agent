import { describe, it, expect } from "vitest";
import { collectInventory } from "../src/inventory.js";
import { InventoryPayloadSchema } from "../src/shared/schemas.js";

describe("collectInventory", () => {
  it("produces a payload that matches the shared Zod schema", async () => {
    const payload = await collectInventory();
    const parsed = InventoryPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error(parsed.error.issues);
    }
    expect(parsed.success).toBe(true);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("captures plugins/skills/hooks arrays without throwing on missing dirs", async () => {
    const payload = await collectInventory();
    expect(Array.isArray(payload.plugins)).toBe(true);
    expect(Array.isArray(payload.skills)).toBe(true);
    expect(Array.isArray(payload.hooks)).toBe(true);
    expect(Array.isArray(payload.mcpServers)).toBe(true);
  });

  it("hashes hook commands deterministically (12 hex)", async () => {
    const payload = await collectInventory();
    for (const h of payload.hooks) {
      expect(h.commandHash).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});
