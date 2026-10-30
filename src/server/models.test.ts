import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordActiveOllamaHost,
  getLastKnownOllamaHost,
  resolveModelForHost,
  listOllamaModels,
} from "./models.js";

describe("models discovery and dynamic resolution", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("records and retrieves the active Ollama host", () => {
    recordActiveOllamaHost("http://192.168.1.100:11434/");
    assert.equal(getLastKnownOllamaHost(), "http://192.168.1.100:11434");
  });

  it("auto-selects available installed model when configured model is empty or obsolete placeholder", async () => {
    // Mock remote Ollama tags response
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "deepseek-r1:14b",
                details: { parameter_size: "14B" },
                capabilities: ["thinking"],
              },
              {
                name: "llama3.1:8b",
                details: { parameter_size: "8B" },
                capabilities: ["tools"],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    // Obsolete "qwen3:8b" should not crash; it should auto-select a model with tools or first available
    const result = await resolveModelForHost("qwen3:8b", "http://remote-server:11434");
    assert.equal(result.autoSelected, true);
    assert.equal(result.model, "llama3.1:8b"); // Preferred because of 'tools' capability
    assert.ok(result.warning?.includes("Auto-selected available model"));
    assert.deepEqual(result.availableModels, ["deepseek-r1:14b", "llama3.1:8b"]);
  });

  it("preserves exact model if installed on remote host", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      return new Response(
        JSON.stringify({
          models: [
            { name: "mistral:7b" },
            { name: "llama3.1:8b" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await resolveModelForHost("mistral:7b", "http://remote-server:11434");
    assert.equal(result.autoSelected, false);
    assert.equal(result.model, "mistral:7b");
  });

  it("resolves tag prefix when user omits :latest or tag suffix", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      return new Response(
        JSON.stringify({
          models: [
            { name: "llama3.1:latest" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await resolveModelForHost("llama3.1", "http://remote-server:11434");
    assert.equal(result.model, "llama3.1:latest");
  });

  it("provides informative warning when configured model is missing on remote host", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      return new Response(
        JSON.stringify({
          models: [
            { name: "gemma2:9b" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await resolveModelForHost("nonexistent:model", "http://remote-server:11434");
    assert.equal(result.model, "nonexistent:model");
    assert.ok(result.warning?.includes("Available models: [gemma2:9b]"));
  });
});
