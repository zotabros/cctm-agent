import { readFile, writeFile } from "node:fs/promises";
import { ensureConfigDir, STATE_PATH } from "./config.js";

interface StateShape {
  // file path -> byte offset already consumed
  offsets: Record<string, number>;
}

let cache: StateShape | null = null;
let writeTimer: NodeJS.Timeout | null = null;

async function read(): Promise<StateShape> {
  if (cache) return cache;
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    cache = JSON.parse(raw) as StateShape;
    if (!cache.offsets) cache.offsets = {};
  } catch {
    cache = { offsets: {} };
  }
  return cache;
}

export async function getOffset(path: string): Promise<number> {
  const s = await read();
  return s.offsets[path] ?? 0;
}

export async function setOffset(path: string, offset: number): Promise<void> {
  const s = await read();
  s.offsets[path] = offset;
  schedulePersist();
}

function schedulePersist(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void persist();
  }, 1000);
}

export async function persist(): Promise<void> {
  if (!cache) return;
  await ensureConfigDir();
  await writeFile(STATE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}
