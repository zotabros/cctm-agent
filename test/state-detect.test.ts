import { describe, it, expect } from "vitest";
import { detectState, type StateDetectDeps } from "../src/state-detect.js";
import type { PartialConfig } from "../src/config.js";

const fullCfg: PartialConfig = {
  serverUrl: "https://srv",
  label: "lap",
  token: "x".repeat(40),
};

const noTokenCfg: PartialConfig = {
  serverUrl: "https://srv",
  label: "lap",
};

function deps(over: Partial<StateDetectDeps>): StateDetectDeps {
  return {
    loadConfig: async () => null,
    readPid: async () => null,
    pidAlive: () => false,
    probe: async () => ({ kind: "ok" as const }),
    ...over,
  };
}

describe("detectState", () => {
  it("fresh when no config", async () => {
    const s = await detectState(deps({}));
    expect(s.kind).toBe("fresh");
  });

  it("partial when config has no token", async () => {
    const s = await detectState(deps({ loadConfig: async () => noTokenCfg }));
    expect(s.kind).toBe("partial");
  });

  it("idle when config + token, no pid, server ok", async () => {
    const s = await detectState(deps({ loadConfig: async () => fullCfg }));
    expect(s.kind).toBe("idle");
  });

  it("unauthorized when token rejected and no daemon", async () => {
    const s = await detectState(
      deps({
        loadConfig: async () => fullCfg,
        probe: async () => ({ kind: "unauthorized" as const }),
      })
    );
    expect(s.kind).toBe("unauthorized");
  });

  it("unreachable when server cannot be reached and no daemon", async () => {
    const s = await detectState(
      deps({
        loadConfig: async () => fullCfg,
        probe: async () => ({ kind: "unreachable" as const }),
      })
    );
    expect(s.kind).toBe("unreachable");
  });

  it("running when daemon pid alive and server ok", async () => {
    const s = await detectState(
      deps({
        loadConfig: async () => fullCfg,
        readPid: async () => 4242,
        pidAlive: () => true,
      })
    );
    expect(s.kind).toBe("running");
    if (s.kind === "running") expect(s.pid).toBe(4242);
  });

  it("stale-pid when pid file exists but process dead", async () => {
    const s = await detectState(
      deps({
        loadConfig: async () => fullCfg,
        readPid: async () => 4242,
        pidAlive: () => false,
      })
    );
    expect(s.kind).toBe("stale-pid");
  });

  it("running daemon + unauthorized server still surfaces unauthorized", async () => {
    const s = await detectState(
      deps({
        loadConfig: async () => fullCfg,
        readPid: async () => 4242,
        pidAlive: () => true,
        probe: async () => ({ kind: "unauthorized" as const }),
      })
    );
    expect(s.kind).toBe("unauthorized");
  });
});
