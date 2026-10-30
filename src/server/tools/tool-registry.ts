import YAML from "yaml";
import { getIpLocation, type IpLocationData } from "./ip-location.js";
import {
  executeRestEndpoint,
  loadOpenApiSpec,
  formatOpenApiDocs,
  type EndpointExecutionResult,
} from "./openapi.js";
import {
  executeGraphQL,
  introspectGraphQLSchema,
  formatGraphQLDocs,
  type GraphQLExecutionResult,
} from "./graphql.js";
import { resolveAuth, type AuthConfig } from "./auth.js";
import { asString, asNumber } from "../utils.js";

export type ToolType = "ip_location" | "http_request" | "graphql" | "inspect_api" | "custom";

export type ToolAuthType = "none" | "bearer" | "api_key" | "basic" | "hmac";

export interface ToolAuthConfig {
  type: ToolAuthType;
  token?: string;
  tokenEnv?: string;
  key?: string;
  keyEnv?: string;
  headerName?: string;
  in?: "header" | "query";
  paramName?: string;
  username?: string;
  userEnv?: string;
  password?: string;
  passEnv?: string;
  secret?: string;
  secretEnv?: string;
  algorithm?: "sha256" | "sha512";
  timestampHeader?: string;
  includeBody?: boolean;
}

export interface ToolAccessConfig {
  url?: string;
  baseUrl?: string;
  allowedMethods?: string[];
  allowedPaths?: string[];
  allowedDomains?: string[];
  allowPrivateNetworks?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface OmniaToolDefinition {
  id?: string;
  name: string;
  label?: string;
  description: string;
  type: ToolType;
  enabled: boolean;
  access?: ToolAccessConfig;
  auth?: ToolAuthConfig;
  parametersSchema?: Record<string, unknown>;
}

export interface ToolExecutionResponse {
  tool: string;
  operation: string;
  status: "success" | "permission_denied" | "error";
  statusCode?: number;
  data?: unknown;
  error?: string;
  executionMs: number;
  access?: {
    url?: string;
    method?: string;
    authType?: string;
  };
}

// Private / loopback IP patterns to prevent SSRF
const PRIVATE_NETWORK_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
];

/**
 * Built-in default tool suite.
 * Each tool has a clear identifier, description, and individual configuration.
 */
export const DEFAULT_OMNIA_TOOLS: OmniaToolDefinition[] = [
  {
    name: "ip_location",
    label: "IP & Geolocation Inspector",
    description: "Inspects public IP and geographical location details (city, region, country, ISP, coordinates) of the agent runtime environment.",
    type: "ip_location",
    enabled: true,
  },
  {
    name: "call_api_endpoint",
    label: "REST / HTTP API Client",
    description: "Executes HTTP requests to API endpoints with custom methods, query parameters, headers, and body payload.",
    type: "http_request",
    enabled: true,
    access: {
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
  },
  {
    name: "query_graphql",
    label: "GraphQL Client",
    description: "Executes GraphQL queries and mutations against a target GraphQL endpoint with variables.",
    type: "graphql",
    enabled: true,
    access: {
      allowedMethods: ["POST"],
    },
  },
  {
    name: "inspect_api_documentation",
    label: "API Documentation Inspector",
    description: "Inspects OpenAPI (Swagger) specifications or GraphQL schemas to discover available operations, endpoints, and types.",
    type: "inspect_api",
    enabled: true,
  },
];

/**
 * Parse tools from agent configuration.
 * Supports YAML string, JSON string, or native Array of OmniaToolDefinition objects.
 * Merges legacy toggles if present.
 */
export function parseConfiguredTools(config: Record<string, unknown>): OmniaToolDefinition[] {
  let tools: OmniaToolDefinition[] = [];

  const raw = config.omnia_tools ?? config.tools;

  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = YAML.parse(raw);
      if (Array.isArray(parsed)) {
        tools = parsed as OmniaToolDefinition[];
      } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).tools)) {
        tools = (parsed as any).tools as OmniaToolDefinition[];
      }
    } catch {
      // Fallback: try JSON.parse
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          tools = parsed as OmniaToolDefinition[];
        }
      } catch {
        // If neither parses, fall back to default tools
        tools = [];
      }
    }
  } else if (Array.isArray(raw)) {
    tools = raw as OmniaToolDefinition[];
  }

  // If no tools defined in config, start from a deep copy of DEFAULT_OMNIA_TOOLS
  if (tools.length === 0) {
    tools = JSON.parse(JSON.stringify(DEFAULT_OMNIA_TOOLS));
  }

  // Normalize tools: validate names, defaults, and booleans
  tools = tools
    .filter((t) => t && typeof t === "object" && typeof t.name === "string" && t.name.trim().length > 0)
    .map((t) => {
      const normalizedName = t.name.trim();
      const enabled = t.enabled !== false && String(t.enabled) !== "false";
      const type: ToolType = (t.type || (normalizedName.includes("ip") ? "ip_location" : normalizedName.includes("graphql") ? "graphql" : "http_request")) as ToolType;
      return {
        ...t,
        name: normalizedName,
        label: t.label || normalizedName,
        description: t.description || `Tool: ${normalizedName}`,
        type,
        enabled,
        access: t.access ? { ...t.access } : undefined,
        auth: t.auth ? { ...t.auth } : undefined,
      };
    });

  // Check global convenience switches
  const ipToolDisabled =
    config.enable_ip_tool === false ||
    config.enable_ip_tool === "false" ||
    config.enable_ip_location === false ||
    config.enable_ip_location === "false";

  const httpToolDisabled =
    config.enable_http_tool === false ||
    config.enable_http_tool === "false" ||
    config.enable_custom_api_tools === false ||
    config.enable_custom_api_tools === "false";

  const graphqlToolDisabled =
    config.enable_graphql_tool === false ||
    config.enable_graphql_tool === "false";

  const inspectToolDisabled =
    config.enable_inspect_tool === false ||
    config.enable_inspect_tool === "false";

  const isGloballyDisabled =
    config.omnia_mode === "disabled" ||
    config.security_mode === "disabled" ||
    config.omnia_mode === "off";

  for (const t of tools) {
    if (isGloballyDisabled) {
      t.enabled = false;
    } else if (t.type === "ip_location" && ipToolDisabled) {
      t.enabled = false;
    } else if (t.type === "http_request" && httpToolDisabled && !t.access?.url) {
      t.enabled = false;
    } else if (t.type === "graphql" && graphqlToolDisabled && !t.access?.url) {
      t.enabled = false;
    } else if (t.type === "inspect_api" && inspectToolDisabled) {
      t.enabled = false;
    }
  }

  return tools;
}

/**
 * Returns only tools that are currently enabled.
 */
export function getEnabledTools(tools: OmniaToolDefinition[]): OmniaToolDefinition[] {
  return tools.filter((t) => t.enabled === true);
}

/**
 * Convert enabled Omnia tools into Ollama function calling definitions.
 */
export function buildOllamaTools(tools: OmniaToolDefinition[]): unknown[] {
  const enabledTools = getEnabledTools(tools);
  const definitions: unknown[] = [];

  for (const tool of enabledTools) {
    if (tool.parametersSchema && typeof tool.parametersSchema === "object") {
      definitions.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parametersSchema,
        },
      });
      continue;
    }

    switch (tool.type) {
      case "ip_location":
        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "object",
              properties: {
                ip: {
                  type: "string",
                  description: "Optional specific IP address to inspect (default: current connection IP).",
                },
              },
            },
          },
        });
        break;

      case "http_request": {
        const hasPinnedUrl = Boolean(tool.access?.url);
        const allowedMethods = tool.access?.allowedMethods || ["GET", "POST", "PUT", "PATCH", "DELETE"];
        const properties: Record<string, unknown> = {
          method: {
            type: "string",
            enum: allowedMethods,
            description: `HTTP method to use (default: ${allowedMethods[0] || "GET"}).`,
          },
          params: {
            type: "object",
            description: "Query string parameters as key-value pairs.",
          },
          headers: {
            type: "object",
            description: "Optional custom HTTP headers.",
          },
          body: {
            type: "object",
            description: "JSON request body payload for POST, PUT, or PATCH requests.",
          },
        };

        const required: string[] = [];
        if (!hasPinnedUrl) {
          properties.url = {
            type: "string",
            description: tool.access?.baseUrl
              ? `Target endpoint URL (must start with '${tool.access.baseUrl}').`
              : "Full target URL or API endpoint.",
          };
          required.push("url");
        }

        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "object",
              properties,
              required,
            },
          },
        });
        break;
      }

      case "graphql": {
        const hasPinnedUrl = Boolean(tool.access?.url);
        const properties: Record<string, unknown> = {
          query: {
            type: "string",
            description: "GraphQL query or mutation string.",
          },
          variables: {
            type: "object",
            description: "Variables map for the GraphQL query.",
          },
          headers: {
            type: "object",
            description: "Optional custom HTTP headers.",
          },
        };

        const required: string[] = ["query"];
        if (!hasPinnedUrl) {
          properties.url = {
            type: "string",
            description: "Target GraphQL endpoint URL.",
          };
          required.push("url");
        }

        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "object",
              properties,
              required,
            },
          },
        });
        break;
      }

      case "inspect_api":
        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["openapi", "graphql"],
                  description: "Format of the documentation: 'openapi' or 'graphql'.",
                },
                source: {
                  type: "string",
                  description: "URL or local file path to OpenAPI specification or GraphQL endpoint.",
                },
                filter: {
                  type: "string",
                  description: "Optional keyword filter to match specific paths or operation IDs.",
                },
              },
              required: ["source"],
            },
          },
        });
        break;

      default:
        // Generic fallback definition
        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "object",
              properties: {
                payload: {
                  type: "object",
                  description: "Tool input parameters.",
                },
              },
            },
          },
        });
        break;
    }
  }

  return definitions;
}

/**
 * Validate URL against SSRF and tool-specific access parameters.
 */
function validateToolAccess(
  urlStr: string,
  tool: OmniaToolDefinition,
  globalConfig: Record<string, unknown>,
): { allowed: boolean; reason?: string; targetUrl: string } {
  let target = urlStr.trim();

  // If tool has a pinned exact URL and no URL was supplied, use it
  if (!target && tool.access?.url) {
    target = tool.access.url.trim();
  }

  // If tool has a pinned exact URL, verify it matches
  if (tool.access?.url) {
    const pinned = tool.access.url.trim();
    if (target !== pinned && !target.startsWith(pinned)) {
      return {
        allowed: false,
        reason: `Target URL "${target}" does not match configured pinned URL "${pinned}" for tool "${tool.name}".`,
        targetUrl: target,
      };
    }
  }

  // If tool has a baseUrl, verify it matches
  if (tool.access?.baseUrl) {
    const base = tool.access.baseUrl.trim();
    if (!target.startsWith(base)) {
      return {
        allowed: false,
        reason: `Target URL "${target}" does not start with configured baseUrl "${base}" for tool "${tool.name}".`,
        targetUrl: target,
      };
    }
  }

  // Parse hostname for SSRF checks
  let hostname = "";
  try {
    const parsed = new URL(target);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return {
      allowed: false,
      reason: `Invalid URL format: "${target}"`,
      targetUrl: target,
    };
  }

  // SSRF Protection: block private/loopback networks unless explicitly allowed for this tool or globally
  const allowPrivate =
    tool.access?.allowPrivateNetworks === true ||
    globalConfig.omnia_allow_private_networks === true ||
    globalConfig.omnia_allow_private_networks === "true";

  if (!allowPrivate) {
    const isPrivate = PRIVATE_NETWORK_PATTERNS.some((pattern) => pattern.test(hostname));
    if (isPrivate) {
      return {
        allowed: false,
        reason: `Access to host "${hostname}" is blocked by OmnIA SSRF safety policy.`,
        targetUrl: target,
      };
    }
  }

  // Optional tool-specific domain filter (only checked if explicitly defined in tool.access.allowedDomains)
  if (tool.access?.allowedDomains && tool.access.allowedDomains.length > 0) {
    const matchesDomain = tool.access.allowedDomains.some((d) => {
      const clean = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (clean === "*" || clean === hostname) return true;
      if (clean.startsWith("*.") && hostname.endsWith(clean.slice(1))) return true;
      if (hostname.endsWith(`.${clean}`)) return true;
      return false;
    });

    if (!matchesDomain) {
      return {
        allowed: false,
        reason: `Domain "${hostname}" is not permitted for tool "${tool.name}". Permitted: [${tool.access.allowedDomains.join(", ")}].`,
        targetUrl: target,
      };
    }
  }

  return { allowed: true, targetUrl: target };
}

/**
 * Execute a tool invocation by name against the registered tool list.
 */
export async function executeToolByName(
  name: string,
  rawArgs: Record<string, unknown>,
  tools: OmniaToolDefinition[],
  globalConfig: Record<string, unknown>,
): Promise<ToolExecutionResponse> {
  const startTime = Date.now();

  // Find tool by exact name or recognized aliases
  let tool = tools.find((t) => t.name === name);

  if (!tool) {
    // Check common aliases
    if (name === "get_ip_location" || name === "omnia_ip_location") {
      tool = tools.find((t) => t.type === "ip_location");
    } else if (name === "http_request" || name === "omnia_http_request") {
      tool = tools.find((t) => t.type === "http_request");
    } else if (name === "graphql" || name === "omnia_graphql") {
      tool = tools.find((t) => t.type === "graphql");
    } else if (name === "inspect_api" || name === "omnia_inspect_docs") {
      tool = tools.find((t) => t.type === "inspect_api");
    }
  }

  if (!tool) {
    return {
      tool: name,
      operation: "unknown",
      status: "error",
      error: `Tool "${name}" is not registered in the agent's tool suite.`,
      executionMs: Date.now() - startTime,
    };
  }

  if (tool.enabled !== true) {
    return {
      tool: tool.name,
      operation: tool.type,
      status: "permission_denied",
      error: `Tool "${tool.name}" is currently disabled in agent settings.`,
      executionMs: Date.now() - startTime,
    };
  }

  // 1. IP Location Tool
  if (tool.type === "ip_location") {
    const ipArg = asString(rawArgs.ip, "").trim() || undefined;
    try {
      const data = await getIpLocation(ipArg);
      return {
        tool: tool.name,
        operation: "ip_location",
        status: data.success ? "success" : "error",
        data,
        error: data.error,
        executionMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        tool: tool.name,
        operation: "ip_location",
        status: "error",
        error: `IP location lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  // 2. HTTP / REST Request Tool
  if (tool.type === "http_request") {
    const rawUrl = asString(rawArgs.url, tool.access?.url || "").trim();
    const accessCheck = validateToolAccess(rawUrl, tool, globalConfig);
    if (!accessCheck.allowed) {
      return {
        tool: tool.name,
        operation: "http_request",
        status: "permission_denied",
        error: accessCheck.reason,
        executionMs: Date.now() - startTime,
        access: { url: rawUrl },
      };
    }

    const method = (asString(rawArgs.method, tool.access?.allowedMethods?.[0] || "GET")).toUpperCase();
    if (tool.access?.allowedMethods && tool.access.allowedMethods.length > 0) {
      const upperAllowed = tool.access.allowedMethods.map((m) => m.toUpperCase());
      if (!upperAllowed.includes(method)) {
        return {
          tool: tool.name,
          operation: "http_request",
          status: "permission_denied",
          error: `HTTP method "${method}" is not permitted for tool "${tool.name}". Allowed methods: [${upperAllowed.join(", ")}].`,
          executionMs: Date.now() - startTime,
          access: { url: accessCheck.targetUrl, method },
        };
      }
    }

    // Merge static headers from tool.access.headers + custom headers
    const combinedHeaders: Record<string, string> = {
      ...(tool.access?.headers || {}),
      ...((rawArgs.headers as Record<string, string>) || {}),
    };

    // Resolve authentication: prioritize tool.auth, fallback to global auth token
    const authConfig = tool.auth || (globalConfig.omnia_auth_token ? { type: "bearer" as const, token: String(globalConfig.omnia_auth_token) } : undefined);

    const timeoutMs = tool.access?.timeoutMs || asNumber(globalConfig.omnia_timeout_sec, 15) * 1000;

    try {
      const res = await executeRestEndpoint({
        url: accessCheck.targetUrl,
        method,
        pathParams: rawArgs.path_params as Record<string, unknown>,
        queryParams: (rawArgs.query_params || rawArgs.params) as Record<string, unknown>,
        headers: combinedHeaders,
        body: rawArgs.body,
        auth: authConfig as AuthConfig,
        timeoutMs,
      });

      return {
        tool: tool.name,
        operation: "http_request",
        status: res.success ? "success" : "error",
        statusCode: res.status,
        data: res.data,
        error: res.error,
        executionMs: res.durationMs,
        access: {
          url: res.url,
          method,
          authType: authConfig?.type,
        },
      };
    } catch (err) {
      return {
        tool: tool.name,
        operation: "http_request",
        status: "error",
        error: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  // 3. GraphQL Tool
  if (tool.type === "graphql") {
    const rawUrl = asString(rawArgs.url, tool.access?.url || asString(globalConfig.graphql_endpoint_url, "")).trim();
    const accessCheck = validateToolAccess(rawUrl, tool, globalConfig);
    if (!accessCheck.allowed) {
      return {
        tool: tool.name,
        operation: "graphql",
        status: "permission_denied",
        error: accessCheck.reason,
        executionMs: Date.now() - startTime,
        access: { url: rawUrl },
      };
    }

    const query = asString(rawArgs.query, "").trim();
    if (!query) {
      return {
        tool: tool.name,
        operation: "graphql",
        status: "error",
        error: "GraphQL operation requires a 'query' argument.",
        executionMs: Date.now() - startTime,
      };
    }

    const combinedHeaders: Record<string, string> = {
      ...(tool.access?.headers || {}),
      ...((rawArgs.headers as Record<string, string>) || {}),
    };

    const authConfig = tool.auth || (globalConfig.omnia_auth_token ? { type: "bearer" as const, token: String(globalConfig.omnia_auth_token) } : undefined);
    const timeoutMs = tool.access?.timeoutMs || asNumber(globalConfig.omnia_timeout_sec, 15) * 1000;

    try {
      const res = await executeGraphQL({
        url: accessCheck.targetUrl,
        query,
        variables: rawArgs.variables as Record<string, unknown>,
        headers: combinedHeaders,
        auth: authConfig as AuthConfig,
        timeoutMs,
      });

      return {
        tool: tool.name,
        operation: "graphql",
        status: res.success ? "success" : "error",
        statusCode: res.status,
        data: res.data,
        error: res.errors ? JSON.stringify(res.errors) : (res.errorMessage || undefined),
        executionMs: res.durationMs,
        access: {
          url: res.url,
          authType: authConfig?.type,
        },
      };
    } catch (err) {
      return {
        tool: tool.name,
        operation: "graphql",
        status: "error",
        error: `GraphQL operation failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  // 4. API Docs Inspector Tool
  if (tool.type === "inspect_api") {
    const source = asString(rawArgs.source || rawArgs.url, asString(globalConfig.openapi_spec_url, "")).trim();
    const docType = asString(rawArgs.type, source.includes("graphql") ? "graphql" : "openapi").toLowerCase();
    const filter = asString(rawArgs.filter, "").trim() || undefined;

    try {
      if (docType === "graphql") {
        const schema = await introspectGraphQLSchema(source);
        const docs = formatGraphQLDocs(schema, filter);
        return {
          tool: tool.name,
          operation: "inspect_api",
          status: "success",
          data: { type: "graphql", endpoint: source, documentation: docs },
          executionMs: Date.now() - startTime,
        };
      } else {
        const spec = await loadOpenApiSpec(source);
        const docs = formatOpenApiDocs(spec, filter);
        return {
          tool: tool.name,
          operation: "inspect_api",
          status: "success",
          data: { type: "openapi", source, documentation: docs },
          executionMs: Date.now() - startTime,
        };
      }
    } catch (err) {
      return {
        tool: tool.name,
        operation: "inspect_api",
        status: "error",
        error: `API documentation inspection failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  return {
    tool: tool.name,
    operation: tool.type,
    status: "error",
    error: `Unhandled tool type "${tool.type}".`,
    executionMs: Date.now() - startTime,
  };
}
