import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseConfiguredTools,
  getEnabledTools,
  buildOllamaTools,
  executeToolByName,
  DEFAULT_OMNIA_TOOLS,
  type OmniaToolDefinition,
} from "./tool-registry.js";

describe("OmnIA Tool Registry - Management, Access & Authentication", () => {
  it("loads default tools with clear identification when no custom tools are defined", () => {
    const tools = parseConfiguredTools({});
    assert.equal(tools.length, 4);
    assert.deepEqual(
      tools.map((t) => t.name),
      ["ip_location", "call_api_endpoint", "query_graphql", "inspect_api_documentation"],
    );
    assert.ok(tools.every((t) => t.enabled === true));
  });

  it("supports adding custom tools with individual endpoints, methods and auth (Aggiunta)", () => {
    const yamlConfig = `
- name: github_issues
  label: "GitHub Issues API"
  description: "Query open issues from Paperclip GitHub repository"
  type: http_request
  enabled: true
  access:
    url: "https://api.github.com/repos/paperclipai/paperclip/issues"
    allowedMethods: ["GET"]
  auth:
    type: bearer
    token: "ghp_mock_secret_token_123"

- name: ip_location
  type: ip_location
  enabled: true
`;
    const tools = parseConfiguredTools({ omnia_tools: yamlConfig });
    assert.equal(tools.length, 2);

    const githubTool = tools.find((t) => t.name === "github_issues");
    assert.ok(githubTool);
    assert.equal(githubTool.enabled, true);
    assert.equal(githubTool.access?.url, "https://api.github.com/repos/paperclipai/paperclip/issues");
    assert.deepEqual(githubTool.access?.allowedMethods, ["GET"]);
    assert.equal(githubTool.auth?.type, "bearer");
    assert.equal(githubTool.auth?.token, "ghp_mock_secret_token_123");
  });

  it("supports removing tools from the suite (Rimozione)", () => {
    const jsonConfig = JSON.stringify([
      {
        name: "ip_location",
        type: "ip_location",
        enabled: true,
      },
    ]);
    const tools = parseConfiguredTools({ omnia_tools: jsonConfig });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "ip_location");
    // Other default tools (call_api_endpoint, query_graphql, etc.) are successfully removed
    assert.equal(tools.find((t) => t.name === "call_api_endpoint"), undefined);
  });

  it("supports disabling and enabling individual tools (Disabilita / Abilita)", () => {
    const yamlConfig = `
- name: ip_location
  type: ip_location
  enabled: false

- name: call_api_endpoint
  type: http_request
  enabled: true
`;
    const tools = parseConfiguredTools({ omnia_tools: yamlConfig });
    const enabled = getEnabledTools(tools);

    assert.equal(tools.length, 2);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].name, "call_api_endpoint");

    // Ollama tools definition must only contain enabled tools
    const ollamaTools = buildOllamaTools(tools) as any[];
    assert.equal(ollamaTools.length, 1);
    assert.equal(ollamaTools[0].function.name, "call_api_endpoint");
  });

  it("rejects execution when an individual tool is disabled", async () => {
    const tools: OmniaToolDefinition[] = [
      {
        name: "test_disabled_tool",
        description: "Disabled tool test",
        type: "http_request",
        enabled: false,
      },
    ];

    const res = await executeToolByName("test_disabled_tool", {}, tools, {});
    assert.equal(res.status, "permission_denied");
    assert.ok(res.error?.includes("currently disabled"));
  });

  it("enforces individual access parameters (allowedMethods)", async () => {
    const tools: OmniaToolDefinition[] = [
      {
        name: "read_only_api",
        description: "Only GET allowed",
        type: "http_request",
        enabled: true,
        access: {
          url: "https://api.example.com/items",
          allowedMethods: ["GET"],
        },
      },
    ];

    // Attempt POST on a GET-only tool
    const res = await executeToolByName(
      "read_only_api",
      { method: "POST", body: { name: "test" } },
      tools,
      {},
    );
    assert.equal(res.status, "permission_denied");
    assert.ok(res.error?.includes('HTTP method "POST" is not permitted'));
  });

  it("enforces individual access parameters (pinned URL or baseUrl mismatch)", async () => {
    const tools: OmniaToolDefinition[] = [
      {
        name: "internal_api",
        description: "Scoped API",
        type: "http_request",
        enabled: true,
        access: {
          baseUrl: "https://api.github.com",
        },
      },
    ];

    // Attempt calling a different host
    const res = await executeToolByName(
      "internal_api",
      { url: "https://evil.com/steal" },
      tools,
      {},
    );
    assert.equal(res.status, "permission_denied");
    assert.ok(res.error?.includes("does not start with configured baseUrl"));
  });

  it("blocks private network and SSRF targets unless explicitly allowed", async () => {
    const tools: OmniaToolDefinition[] = [
      {
        name: "web_fetch",
        description: "Web fetcher",
        type: "http_request",
        enabled: true,
      },
    ];

    const res = await executeToolByName(
      "web_fetch",
      { url: "http://127.0.0.1:8080/admin" },
      tools,
      {},
    );
    assert.equal(res.status, "permission_denied");
    assert.ok(res.error?.includes("blocked by OmnIA SSRF safety policy"));
  });

  it("does not require a mandatory domain whitelist when accessing public targets", () => {
    const tools = parseConfiguredTools({
      omnia_allowed_domains: "", // Empty whitelist!
    });
    // Tools exist and are active without throwing or blocking
    assert.equal(tools.length, 4);
    assert.ok(tools.every((t) => t.enabled === true));
  });

  it("correctly parses both YAML and JSON tool definitions", () => {
    // 1. YAML
    const yaml = `
- name: tool_one
  type: ip_location
  enabled: true
`;
    const toolsYaml = parseConfiguredTools({ omnia_tools: yaml });
    assert.equal(toolsYaml.length, 1);
    assert.equal(toolsYaml[0].name, "tool_one");

    // 2. JSON
    const json = `[{"name": "tool_two", "type": "http_request", "enabled": true}]`;
    const toolsJson = parseConfiguredTools({ omnia_tools: json });
    assert.equal(toolsJson.length, 1);
    assert.equal(toolsJson[0].name, "tool_two");
  });
});
