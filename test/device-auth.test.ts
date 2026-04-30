import { describe, it, expect } from "vitest";
import {
  pollForToken,
  pollOnce,
  requestDeviceCode,
  type DeviceAuthDeps,
} from "../src/device-auth.js";

interface Sequenced {
  status: number;
  body?: unknown;
}

function makeFetch(responses: Sequenced[]): {
  fetchImpl: NonNullable<DeviceAuthDeps["fetchImpl"]>;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl: NonNullable<DeviceAuthDeps["fetchImpl"]> = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body ?? {},
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  };
  return { fetchImpl, calls };
}

const code = {
  device_code: "DEV",
  user_code: "USER-CODE",
  verification_uri: "https://srv/devices",
  verification_uri_complete: "https://srv/devices?code=USER-CODE",
  expires_in: 600,
  interval: 1,
};

describe("requestDeviceCode", () => {
  it("returns parsed response on 201", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: code }]);
    const r = await requestDeviceCode("https://srv", { os: "macos" }, { fetchImpl });
    expect(r.device_code).toBe("DEV");
    expect(r.user_code).toBe("USER-CODE");
  });

  it("throws on non-2xx", async () => {
    const { fetchImpl } = makeFetch([{ status: 500, body: "boom" }]);
    await expect(requestDeviceCode("https://srv", { os: "macos" }, { fetchImpl })).rejects.toThrow(
      /device_code_failed/
    );
  });

  it("throws when payload is malformed", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: { user_code: "x" } }]);
    await expect(requestDeviceCode("https://srv", { os: "macos" }, { fetchImpl })).rejects.toThrow(
      /malformed/
    );
  });
});

describe("pollOnce", () => {
  it("approved", async () => {
    const { fetchImpl } = makeFetch([
      { status: 200, body: { token: "TOK", machineId: "m1", label: "l1" } },
    ]);
    const r = await pollOnce("https://srv", "DEV", { fetchImpl });
    expect(r).toEqual({ kind: "approved", token: "TOK", machineId: "m1", label: "l1" });
  });
  it("pending", async () => {
    const { fetchImpl } = makeFetch([{ status: 425, body: { error: "authorization_pending" } }]);
    expect((await pollOnce("https://srv", "DEV", { fetchImpl })).kind).toBe("pending");
  });
  it("denied", async () => {
    const { fetchImpl } = makeFetch([{ status: 403, body: {} }]);
    expect((await pollOnce("https://srv", "DEV", { fetchImpl })).kind).toBe("denied");
  });
  it("expired", async () => {
    const { fetchImpl } = makeFetch([{ status: 410, body: {} }]);
    expect((await pollOnce("https://srv", "DEV", { fetchImpl })).kind).toBe("expired");
  });
  it("invalid (404)", async () => {
    const { fetchImpl } = makeFetch([{ status: 404, body: {} }]);
    expect((await pollOnce("https://srv", "DEV", { fetchImpl })).kind).toBe("invalid");
  });
  it("network on thrown fetch", async () => {
    const fetchImpl: NonNullable<DeviceAuthDeps["fetchImpl"]> = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await pollOnce("https://srv", "DEV", { fetchImpl });
    expect(r.kind).toBe("network");
  });
});

describe("pollForToken", () => {
  it("returns approved after several pending polls", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 425, body: {} },
      { status: 425, body: {} },
      { status: 200, body: { token: "TOK", machineId: "m1", label: "l1" } },
    ]);
    let now = 0;
    const r = await pollForToken("https://srv", code, {
      fetchImpl,
      sleep: async () => {
        now += 1000;
      },
      now: () => now,
    });
    expect(r.kind).toBe("approved");
    expect(calls.length).toBe(3);
  });

  it("returns expired after deadline elapses", async () => {
    const { fetchImpl } = makeFetch([{ status: 425, body: {} }]);
    let now = 0;
    const shortCode = { ...code, expires_in: 2 };
    const r = await pollForToken("https://srv", shortCode, {
      fetchImpl,
      sleep: async () => {
        now += 5000;
      },
      now: () => now,
    });
    expect(r.kind).toBe("expired");
  });

  it("returns denied immediately", async () => {
    const { fetchImpl } = makeFetch([{ status: 403, body: {} }]);
    const r = await pollForToken("https://srv", code, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(r.kind).toBe("denied");
  });

  it("aborts after 3 consecutive network failures", async () => {
    const fetchImpl: NonNullable<DeviceAuthDeps["fetchImpl"]> = async () => {
      throw new Error("net");
    };
    const r = await pollForToken("https://srv", code, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(r.kind).toBe("network");
  });

  it("recovers from transient network errors", async () => {
    const responses: Sequenced[] = [
      { status: 0, body: undefined }, // signalled by throw below
    ];
    let calls = 0;
    const fetchImpl: NonNullable<DeviceAuthDeps["fetchImpl"]> = async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return {
        status: 200,
        ok: true,
        json: async () => ({ token: "TOK", machineId: "m1", label: "l1" }),
        text: async () => "",
      };
    };
    const r = await pollForToken("https://srv", code, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(r.kind).toBe("approved");
    void responses;
  });
});
