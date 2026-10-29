import { describe, it, expect } from "vitest";
import { createServerAdapter } from "./index.js";

describe("ollama_local adapter", () => {
  const adapter = createServerAdapter();

  it("exports correct metadata and capability flags", () => {
    expect(adapter.type).toBe("ollama_local");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
  });

  it("provides comprehensive Open WebUI model parameters in getConfigSchema", async () => {
    expect(adapter.getConfigSchema).toBeDefined();
    const schema = await adapter.getConfigSchema!();
    expect(schema).toBeDefined();
    expect(schema.fields.length).toBeGreaterThanOrEqual(15);

    const keys = schema.fields.map((f: { key: string }) => f.key);
    expect(keys).toContain("baseUrl");
    expect(keys).toContain("temperature");
    expect(keys).toContain("num_ctx");
    expect(keys).toContain("num_predict");
    expect(keys).toContain("top_p");
    expect(keys).toContain("top_k");
    expect(keys).toContain("min_p");
    expect(keys).toContain("repeat_penalty");
    expect(keys).toContain("repeat_last_n");
    expect(keys).toContain("presence_penalty");
    expect(keys).toContain("frequency_penalty");
    expect(keys).toContain("mirostat");
    expect(keys).toContain("mirostat_tau");
    expect(keys).toContain("mirostat_eta");
    expect(keys).toContain("keep_alive");
    expect(keys).toContain("seed");
    expect(keys).toContain("stop");
    expect(keys).toContain("system");

    // Check defaults
    const tempField = schema.fields.find((f: { key: string }) => f.key === "temperature");
    expect(tempField?.default).toBe(0.8);

    const ctxField = schema.fields.find((f: { key: string }) => f.key === "num_ctx");
    expect(ctxField?.default).toBe(4096);

    const predictField = schema.fields.find((f: { key: string }) => f.key === "num_predict");
    expect(predictField?.default).toBe(2048);

    const mirostatField = schema.fields.find((f: { key: string }) => f.key === "mirostat");
    expect(mirostatField?.type).toBe("select");
    expect(mirostatField?.options?.length).toBe(3);
  });

  it("tests environment against local Ollama", async () => {
    const res = await adapter.testEnvironment({
      companyId: "company-1",
      adapterType: "ollama_local",
      config: { baseUrl: "http://127.0.0.1:11434" },
    });

    expect(res.adapterType).toBe("ollama_local");
    expect(res.status).toBe("pass");
    expect(res.checks.length).toBeGreaterThan(0);
    expect(res.checks[0].code).toBe("ollama_connected");
  });

  it("lists models dynamically from local Ollama", async () => {
    expect(adapter.listModels).toBeDefined();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids.some((id) => id.includes("qwen") || id.includes("gemma"))).toBe(true);
  });

  it("executes a streaming chat turn with model parameters", async () => {
    const logs: string[] = [];
    const result = await adapter.execute({
      runId: "vitest-run-1",
      agent: { id: "agent-1", companyId: "co-1", name: "Ollama Tester", adapterType: "ollama_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: null },
      config: {
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:3b",
        temperature: 0.2,
        num_predict: 25,
        num_ctx: 2048,
        system: "You are a concise test agent. Respond in exactly 2 words.",
      },
      context: {
        prompt: "Say hello test",
      },
      onLog: async (stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen2.5:3b");
    expect(result.usage).toBeDefined();
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
  });
});
