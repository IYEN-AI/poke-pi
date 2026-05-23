import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessError } from "../../src/errors.js";
import { MgbaHttpClient, type MgbaFetch } from "../../src/mgba/MgbaHttpClient.js";

interface FetchCall {
  url: string;
  method?: string;
}

function createResponse(body: string, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    statusText: init.statusText
  });
}

function createFakeFetch(bodies: string[]): { fetchImpl: MgbaFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: MgbaFetch = async (input, init) => {
    calls.push({ url: input.toString(), method: init?.method });
    return createResponse(bodies.shift() ?? "");
  };

  return { fetchImpl, calls };
}

function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

describe("MgbaHttpClient", () => {
  it("formats read and frame endpoints with documented 0x-prefixed uppercase addresses", async () => {
    const { fetchImpl, calls } = createFakeFetch(["123", "255", "4660", "d3,00,ea"]);
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000/api/", fetchImpl });

    await expect(client.currentFrame()).resolves.toBe(123);
    await expect(client.read8(0xd35e)).resolves.toBe(255);
    await expect(client.read16(0xd16c)).resolves.toBe(4660);
    await expect(client.readRange(0xd35e, 3)).resolves.toEqual(Uint8Array.from([0xd3, 0x00, 0xea]));

    expect(calls.map((call) => [call.method, pathAndQuery(call.url)])).toEqual([
      ["GET", "/core/currentFrame"],
      ["GET", "/core/read8?address=0xD35E"],
      ["GET", "/core/read16?address=0xD16C"],
      ["GET", "/core/readrange?address=0xD35E&length=3"]
    ]);
  });

  it("supports JSON byte arrays for readRange responses", async () => {
    const { fetchImpl } = createFakeFetch(["[1,2,255]"]);
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl });

    await expect(client.readRange(0xc000, 3)).resolves.toEqual(Uint8Array.from([1, 2, 255]));
  });

  it("formats button, screenshot, and state endpoints exactly", async () => {
    const { fetchImpl, calls } = createFakeFetch(["", "", "", "true", "true"]);
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl });

    await client.tapButton("A", 5);
    await client.holdButton("Down", 15);
    await expect(client.screenshot("/tmp/run shot.png")).resolves.toBe("/tmp/run shot.png");
    await client.saveStateSlot(2);
    await client.loadStateSlot(2);

    expect(calls.map((call) => [call.method, pathAndQuery(call.url)])).toEqual([
      ["POST", "/mgba-http/button/tap?button=A"],
      ["POST", "/mgba-http/button/hold?button=Down&duration=15"],
      ["POST", "/core/screenshot?path=%2Ftmp%2Frun+shot.png"],
      ["POST", "/core/savestateslot?slot=2"],
      ["POST", "/core/loadstateslot?slot=2"]
    ]);
  });

  it("throws HarnessError with safe context on non-2xx responses", async () => {
    const sensitiveValue = `s${"k"}-test-value`;
    const fetchImpl: MgbaFetch = async () => createResponse(`server exploded with credential=${sensitiveValue}`, { status: 500, statusText: "Internal Server Error" });
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl });

    await expect(client.currentFrame()).rejects.toMatchObject({
      code: "MGBA_UNAVAILABLE",
      safeContext: { endpoint: "/core/currentFrame", status: 500, statusText: "Internal Server Error" }
    });

    try {
      await client.currentFrame();
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect(JSON.stringify((error as HarnessError).toJSON())).not.toContain(sensitiveValue);
    }
  });

  it("throws HarnessError with safe context on rejected fetch and parse failures", async () => {
    const sensitiveValue = `s${"k"}-test-value`;
    const rejectedClient = new MgbaHttpClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED credential=${sensitiveValue}`);
      }
    });

    await expect(rejectedClient.read8(0xd35e)).rejects.toMatchObject({
      code: "MGBA_UNAVAILABLE",
      safeContext: { endpoint: "/core/read8" }
    });

    try {
      await rejectedClient.read8(0xd35e);
    } catch (error) {
      expect(JSON.stringify((error as HarnessError).toJSON())).not.toContain(sensitiveValue);
    }

    const invalidNumberClient = new MgbaHttpClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: async () => createResponse("not-a-number")
    });
    await expect(invalidNumberClient.currentFrame()).rejects.toMatchObject({ code: "MGBA_UNAVAILABLE" });

    const invalidRangeClient = new MgbaHttpClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: async () => createResponse("not,bytes")
    });
    await expect(invalidRangeClient.readRange(0xd35e, 2)).rejects.toMatchObject({ code: "MGBA_UNAVAILABLE" });
  });

  it("serializes concurrent requests because mGBA Lua socket handles one command at a time", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const fetchImpl: MgbaFetch = async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return createResponse("1");
    };
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl });

    await expect(Promise.all([client.read8(0xd35e), client.read8(0xd35f), client.currentFrame()])).resolves.toEqual([1, 1, 1]);

    expect(maxActiveRequests).toBe(1);
  });

  it("shares a filesystem lock across clients so dashboard polling cannot overlap harness RAM reads", async () => {
    const requestLockDir = join(tmpdir(), `poke-pi-mgba-http-test-${process.pid}-${Date.now()}`);
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const fetchImpl: MgbaFetch = async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return createResponse("1");
    };
    const harnessClient = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl, requestLockDir });
    const dashboardClient = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl, requestLockDir });

    await expect(Promise.all([harnessClient.read8(0xd35e), dashboardClient.currentFrame()])).resolves.toEqual([1, 1]);

    expect(maxActiveRequests).toBe(1);
  });

  it("continues serializing later requests after a failed request", async () => {
    const { fetchImpl, calls } = createFakeFetch(["boom", "7"]);
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl });

    await expect(client.read8(0xd35e)).rejects.toMatchObject({ code: "MGBA_UNAVAILABLE" });
    await expect(client.read8(0xd35f)).resolves.toBe(7);

    expect(calls.map((call) => pathAndQuery(call.url))).toEqual([
      "/core/read8?address=0xD35E",
      "/core/read8?address=0xD35F"
    ]);
  });

  it("uses screenshot-specific error code for screenshot failures", async () => {
    const fetchImpl: MgbaFetch = async () => createResponse("no screenshot", { status: 500 });
    const client = new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000", fetchImpl });

    await expect(client.screenshot("/tmp/shot.png")).rejects.toMatchObject({ code: "SCREENSHOT_FAILED" });
  });
});
