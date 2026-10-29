import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getIpLocation,
  getPublicIp,
  IP_LOCATION_TOOL_DEFINITION,
} from "./ip-location.ts";
import { parseStdoutLine } from "../../ui-parser.ts";

describe("Ollama IP Location Tool", () => {
  const originalFetch = globalThis.fetch;
  let requestedUrls: string[] = [];

  before(() => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);

      if (url.includes("ipify.org")) {
        return new Response(JSON.stringify({ ip: "93.45.67.89" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("ipwho.is")) {
        return new Response(
          JSON.stringify({
            ip: "8.8.8.8",
            success: true,
            type: "IPv4",
            country: "United States",
            country_code: "US",
            region: "California",
            city: "Mountain View",
            postal: "94043",
            latitude: 37.4223,
            longitude: -122.0848,
            connection: {
              asn: 15169,
              isp: "Google LLC",
              org: "Google LLC",
            },
            timezone: {
              id: "America/Los_Angeles",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("ip-api.com")) {
        return new Response(
          JSON.stringify({
            status: "success",
            country: "Italy",
            countryCode: "IT",
            regionName: "Lazio",
            city: "Rome",
            zip: "00100",
            lat: 41.89,
            lon: 12.48,
            timezone: "Europe/Rome",
            isp: "Telecom Italia",
            as: "AS1234",
            query: "93.45.67.89",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    requestedUrls = [];
  });

  it("exports a valid Ollama function tool definition", () => {
    assert.strictEqual(IP_LOCATION_TOOL_DEFINITION.type, "function");
    assert.strictEqual(IP_LOCATION_TOOL_DEFINITION.function.name, "get_ip_location");
    assert.ok(IP_LOCATION_TOOL_DEFINITION.function.description.includes("IP"));
    assert.strictEqual(IP_LOCATION_TOOL_DEFINITION.function.parameters.type, "object");
  });

  it("fetches raw public IP using api.ipify.org via getPublicIp()", async () => {
    const ip = await getPublicIp();
    assert.strictEqual(ip, "93.45.67.89");
    assert.ok(requestedUrls.some((u) => u.includes("ipify.org")));
  });

  it("discovers public IP via api.ipify.org first when targetIp is omitted, then resolves location", async () => {
    const data = await getIpLocation();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.detected_via, "api.ipify.org");
    assert.ok(requestedUrls.some((u) => u.includes("ipify.org")));
    assert.ok(requestedUrls.some((u) => u.includes("ipwho.is")));
  });

  it("fetches and normalizes location data via primary provider (ipwho.is)", async () => {
    const data = await getIpLocation("8.8.8.8");
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.ip, "8.8.8.8");
    assert.strictEqual(data.city, "Mountain View");
    assert.strictEqual(data.region, "California");
    assert.strictEqual(data.country, "United States");
    assert.strictEqual(data.timezone, "America/Los_Angeles");
    assert.strictEqual(data.isp, "Google LLC");
    assert.strictEqual(data.source, "ipwho.is");
  });

  it("falls back to secondary provider (ip-api.com) when primary fails", async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ipwho.is")) {
        throw new Error("Simulated connection error to ipwho.is");
      }
      return prevFetch(input);
    }) as typeof fetch;

    try {
      const data = await getIpLocation("93.45.67.89");
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.city, "Rome");
      assert.strictEqual(data.country, "Italy");
      assert.strictEqual(data.isp, "Telecom Italia");
      assert.strictEqual(data.source, "ip-api.com");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  describe("UI Parser Tool Call and Result Parsing", () => {
    it("parses tool call log marker into kind: 'tool_call'", () => {
      const line = '[ollama_local:tool_call] {"name":"get_ip_location","arguments":{"ip":"8.8.8.8"},"id":"call-123"}';
      const entries = parseStdoutLine(line, "2026-10-28T14:00:00Z");
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].kind, "tool_call");
      assert.strictEqual(entries[0].name, "get_ip_location");
      assert.deepStrictEqual(entries[0].input, { ip: "8.8.8.8" });
    });

    it("parses tool result log marker into kind: 'tool_result'", () => {
      const payload = JSON.stringify({ ip: "8.8.8.8", city: "Mountain View", country: "United States" });
      const line = `[ollama_local:tool_result] ${payload}`;
      const entries = parseStdoutLine(line, "2026-10-28T14:00:00Z");
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].kind, "tool_result");
      assert.strictEqual(entries[0].content, payload);
    });
  });

  describe("End-to-end execute() with Ollama tool calling", () => {
    it("handles Ollama tool call request and completes two-pass execution", async () => {
      const { execute } = await import("../../../dist/server/execute.js");
      const loggedChunks: string[] = [];
      let chatCallCount = 0;

      const prevFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.includes("/api/chat")) {
          chatCallCount++;
          if (chatCallCount === 1) {
            // Ollama decides to call get_ip_location
            const chunk = JSON.stringify({
              model: "qwen3:8b",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "get_ip_location",
                      arguments: { ip: "8.8.8.8" },
                    },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 35,
              eval_count: 12,
            });
            return new Response(`${chunk}\n`, {
              status: 200,
              headers: { "Content-Type": "application/x-ndjson" },
            });
          } else {
            // Follow-up call: model receives tool output and responds
            const chunk = JSON.stringify({
              model: "qwen3:8b",
              message: {
                role: "assistant",
                content: "L'indirizzo IP 8.8.8.8 corrisponde a Mountain View, California (Google LLC).",
              },
              done: true,
              prompt_eval_count: 80,
              eval_count: 22,
            });
            return new Response(`${chunk}\n`, {
              status: 200,
              headers: { "Content-Type": "application/x-ndjson" },
            });
          }
        }

        return prevFetch(input, init);
      }) as typeof fetch;

      try {
        const result = await execute({
          runId: "run-tool-test",
          agent: {
            id: "agent-1",
            companyId: "co-1",
            name: "IP Detective",
            adapterConfig: {},
          },
          runtime: { sessionId: null, sessionParams: null },
          config: {
            baseUrl: "http://127.0.0.1:11434",
            model: "qwen3:8b",
            enable_ip_tool: true,
          },
          context: {
            prompt: "Qual è la posizione dell'IP 8.8.8.8?",
          },
          onLog: async (_, chunk) => {
            loggedChunks.push(chunk);
          },
        });

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(chatCallCount, 2);
        assert.strictEqual(result.usage?.inputTokens, 115);
        assert.strictEqual(result.usage?.outputTokens, 34);

        const joinedLogs = loggedChunks.join("");
        assert.ok(joinedLogs.includes("[ollama_local:tool_call]"));
        assert.ok(joinedLogs.includes('"name":"get_ip_location"'));
        assert.ok(joinedLogs.includes("[ollama_local:tool_result]"));
        assert.ok(joinedLogs.includes("Mountain View"));
        assert.ok(joinedLogs.includes("L'indirizzo IP 8.8.8.8 corrisponde a Mountain View"));
      } finally {
        globalThis.fetch = prevFetch;
      }
    });
  });
});
