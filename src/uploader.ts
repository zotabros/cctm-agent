import { appendFile } from "node:fs/promises";
import pc from "picocolors";
import type { IngestEvent } from "@cctm/shared";
import { ensureConfigDir, QUEUE_PATH, type Config } from "./config.js";

const MAX_BATCH = 200;
const FLUSH_INTERVAL_MS = 60_000;
const RETRY_BACKOFF_MS = [500, 2_000, 5_000];

export class Uploader {
  private buffer: IngestEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private readonly cfg: Config) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  push(events: IngestEvent[]): void {
    if (events.length === 0) return;
    this.buffer.push(...events);
    if (this.buffer.length >= MAX_BATCH) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, MAX_BATCH);
        try {
          await this.send(batch);
        } catch (err) {
          console.error(pc.red(`[uploader] failed: ${(err as Error).message}`));
          await this.queueFailed(batch);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async send(events: IngestEvent[]): Promise<void> {
    const url = `${this.cfg.serverUrl.replace(/\/$/, "")}/api/ingest`;
    const body = JSON.stringify({ machineLabel: this.cfg.label, events });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.token}`,
          },
          body,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const result = (await res.json()) as { accepted?: number };
        console.log(
          pc.dim(
            `[uploader] sent ${events.length} events, accepted ${result.accepted ?? "?"}`
          )
        );
        return;
      } catch (err) {
        lastError = err as Error;
        const delay = RETRY_BACKOFF_MS[attempt];
        if (delay !== undefined) await sleep(delay);
      }
    }
    throw lastError ?? new Error("upload_failed");
  }

  private async queueFailed(events: IngestEvent[]): Promise<void> {
    try {
      await ensureConfigDir();
      const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(QUEUE_PATH, lines, "utf-8");
      console.log(pc.yellow(`[uploader] queued ${events.length} events to ${QUEUE_PATH}`));
    } catch (err) {
      console.error(pc.red(`[uploader] queue write failed: ${(err as Error).message}`));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
