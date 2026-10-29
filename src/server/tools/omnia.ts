import { getIpLocation, type IpLocationData } from "./ip-location.js";
import { executeRestEndpoint, loadOpenApiSpec, formatOpenApiDocs } from "./openapi.js";
import { executeGraphQL, introspectGraphQLSchema, formatGraphQLDocs } from "./graphql.js";
import { asString, asNumber } from "../utils.js";

export type OmniaOperation = "ip_location" | "http_request" | "graphql_query" | "inspect_api";
export type OmniaPermissionMode = "restricted" | "permissive" | "read_only" | "disabled";

export interface OmniaPermissions {
  mode: OmniaPermissionMode;
  allowedDomains: string[];
  allowedMethods: string[];
  allowPrivateNetworks: boolean;
  authToken?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface OmniaCallArguments {
  operation: OmniaOperation;
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  query?: string;
  variables?: Record<string, unknown>;
  ip?: string;
  notes?: string;
}

export interface OmniaExecutionResult {
  tool: "OmnIA";
  operation: OmniaOperation;
  status: "success" | "permission_denied" | "error";
  statusCode?: number;
  data?: unknown;
  error?: string;
  executionMs?: number;
  policy?: {
    mode: OmniaPermissionMode;
    allowedDomains: string[];
    allowedMethods: string[];
  };
  guidance?: string;
}

// Private IP / SSRF patterns
const PRIVATE_NETWORK_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // Cloud metadata endpoint
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
];

export function parseOmniaPermissions(config: Record<string, unknown>): OmniaPermissions {
  const rawMode = asString(
    config.omnia_mode ||
    config.omniaMode ||
    config.omnia_permissions_mode ||
    config.omniaPermissionsMode ||
    config.security_mode ||
    config.securityMode,
    "permissive",
  ).trim().toLowerCase();

  const mode: OmniaPermissionMode =
    rawMode === "disabled" || rawMode === "off" || rawMode === "none"
      ? "disabled"
      : rawMode === "restricted" || rawMode === "strict"
      ? "restricted"
      : rawMode === "read_only" || rawMode === "readonly" || rawMode === "ro"
      ? "read_only"
      : "permissive";

  const rawDomains = asString(
    config.omnia_allowed_domains ||
    config.omniaAllowedDomains ||
    config.allowed_domains ||
    config.allowedDomains,
    "api.ipify.org, ipwho.is",
  );
  const allowedDomains = rawDomains
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

  const rawMethods = asString(
    config.omnia_allowed_methods ||
    config.omniaAllowedMethods ||
    config.allowed_methods ||
    config.allowedMethods,
    "GET, POST",
  );
  const allowedMethods = rawMethods
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);

  const allowPrivateNetworks =
    config.omnia_allow_private_networks === true ||
    config.omnia_allow_private_networks === "true" ||
    config.omniaAllowPrivateNetworks === true ||
    config.omniaAllowPrivateNetworks === "true";

  const authToken = asString(
    config.omnia_auth_token ||
    config.omniaAuthToken ||
    config.auth_token ||
    config.authToken,
    "",
  ).trim() || undefined;

  const timeoutSec = asNumber(config.omnia_timeout_sec ?? config.omniaTimeoutSec, 15);
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 15000;
  const maxResponseBytes = asNumber(config.omnia_max_response_bytes ?? config.omniaMaxResponseBytes, 50000);

  return {
    mode,
    allowedDomains,
    allowedMethods: allowedMethods.length > 0 ? allowedMethods : ["GET", "POST"],
    allowPrivateNetworks,
    authToken,
    timeoutMs,
    maxResponseBytes,
  };
}

export function isDomainAllowed(
  urlStr: string,
  permissions: OmniaPermissions,
): { allowed: boolean; reason?: string; hostname?: string } {
  if (permissions.mode === "disabled") {
    return {
      allowed: false,
      reason: `OmnIA tool execution is disabled by policy (omnia_mode: "disabled").`,
    };
  }

  let hostname = "";
  try {
    const parsed = new URL(urlStr);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: `Invalid URL format: "${urlStr}"` };
  }

  // SSRF Protection (applies to all modes unless allowPrivateNetworks is true)
  if (!permissions.allowPrivateNetworks) {
    const isPrivate = PRIVATE_NETWORK_PATTERNS.some((pattern) => pattern.test(hostname));
    if (isPrivate) {
      return {
        allowed: false,
        hostname,
        reason: `Access to private/local network host "${hostname}" is blocked by OmnIA SSRF safety policy.`,
      };
    }
  }

  // Permissive mode allows any public host
  if (permissions.mode === "permissive") {
    return { allowed: true, hostname };
  }

  // Read-only mode allows public hosts unless custom restricted domains are explicitly configured without wildcard
  if (permissions.mode === "read_only") {
    if (permissions.allowedDomains.includes("*")) {
      return { allowed: true, hostname };
    }
    const isDefaultList =
      permissions.allowedDomains.length === 2 &&
      permissions.allowedDomains.includes("api.ipify.org") &&
      permissions.allowedDomains.includes("ipwho.is");
    if (isDefaultList) {
      return { allowed: true, hostname };
    }
  }

  // Wildcard allows any public host
  if (permissions.allowedDomains.includes("*")) {
    return { allowed: true, hostname };
  }

  // Check against domain whitelist (strictly applied in Restricted mode)
  const isMatch = permissions.allowedDomains.some((d) => {
    if (d === hostname) return true;
    if (d.startsWith("*.") && hostname.endsWith(d.slice(1))) return true;
    if (hostname.endsWith(`.${d}`)) return true;
    return false;
  });

  if (!isMatch) {
    return {
      allowed: false,
      hostname,
      reason: `Domain "${hostname}" is not in the OmnIA allowed domains list. Permitted: [${permissions.allowedDomains.join(", ")}].`,
    };
  }

  return { allowed: true, hostname };
}

export function isMethodAllowed(
  method: string,
  permissions: OmniaPermissions,
  isMutation: boolean = false,
): { allowed: boolean; reason?: string } {
  if (permissions.mode === "disabled") {
    return { allowed: false, reason: `OmnIA tools are disabled (omnia_mode: "disabled").` };
  }

  const upper = method.toUpperCase();

  // Read-only governance
  if (permissions.mode === "read_only") {
    if (isMutation) {
      return {
        allowed: false,
        reason: `GraphQL mutations are blocked. OmnIA is currently configured in strict "read_only" mode.`,
      };
    }
    if (upper !== "GET" && upper !== "HEAD" && upper !== "OPTIONS") {
      return {
        allowed: false,
        reason: `HTTP method "${upper}" is blocked. OmnIA is currently configured in strict "read_only" mode (only GET, HEAD, OPTIONS are permitted).`,
      };
    }
    return { allowed: true };
  }

  // Permissive mode allows all methods
  if (permissions.mode === "permissive") {
    return { allowed: true };
  }

  // Restricted mode checks allowedMethods
  if (!permissions.allowedMethods.includes(upper)) {
    return {
      allowed: false,
      reason: `Method "${upper}" is not permitted by OmnIA policy. Allowed methods: [${permissions.allowedMethods.join(", ")}].`,
    };
  }

  return { allowed: true };
}

export async function executeOmniaOperation(
  rawArgs: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<OmniaExecutionResult> {
  const startTime = Date.now();
  const permissions = parseOmniaPermissions(config);

  const operation = (asString(rawArgs.operation, "ip_location") as OmniaOperation) || "ip_location";

  // Global policy check: Disabled mode completely halts all operations
  if (permissions.mode === "disabled") {
    return {
      tool: "OmnIA",
      operation,
      status: "permission_denied",
      error: `OmnIA tool execution is disabled by policy (omnia_mode: "disabled"). Network operations are blocked.`,
      policy: {
        mode: permissions.mode,
        allowedDomains: permissions.allowedDomains,
        allowedMethods: permissions.allowedMethods,
      },
      executionMs: Date.now() - startTime,
      guidance: "OmnIA tool operations are disabled in security settings. Explain to the user that external tools are turned off by policy.",
    };
  }

  // 1. IP Location Operation
  if (operation === "ip_location") {
    // In restricted mode, ensure IP discovery domains are whitelisted
    if (permissions.mode === "restricted") {
      const ipifyCheck = isDomainAllowed("https://api.ipify.org", permissions);
      const ipwhoCheck = isDomainAllowed("https://ipwho.is", permissions);
      if (!ipifyCheck.allowed && !ipwhoCheck.allowed) {
        return {
          tool: "OmnIA",
          operation: "ip_location",
          status: "permission_denied",
          error: `OmnIA ip_location is blocked in "restricted" mode: neither "api.ipify.org" nor "ipwho.is" is in the allowed domains whitelist [${permissions.allowedDomains.join(", ")}].`,
          policy: {
            mode: permissions.mode,
            allowedDomains: permissions.allowedDomains,
            allowedMethods: permissions.allowedMethods,
          },
          executionMs: Date.now() - startTime,
          guidance: "OmnIA ip_location was blocked because IP discovery domains are not whitelisted in restricted mode.",
        };
      }
    }

    const targetIp = typeof rawArgs.ip === "string" ? rawArgs.ip.trim() : undefined;
    try {
      const data: IpLocationData = await getIpLocation(targetIp);
      return {
        tool: "OmnIA",
        operation: "ip_location",
        status: data.success ? "success" : "error",
        data,
        policy: {
          mode: permissions.mode,
          allowedDomains: permissions.allowedDomains,
          allowedMethods: permissions.allowedMethods,
        },
        executionMs: Date.now() - startTime,
        guidance: "OmnIA IP location retrieved. Synthesize this geographic and network data to answer the user directly.",
      };
    } catch (err) {
      return {
        tool: "OmnIA",
        operation: "ip_location",
        status: "error",
        error: `OmnIA ip_location failed: ${err instanceof Error ? err.message : String(err)}`,
        policy: {
          mode: permissions.mode,
          allowedDomains: permissions.allowedDomains,
          allowedMethods: permissions.allowedMethods,
        },
        executionMs: Date.now() - startTime,
      };
    }
  }

  // 2. HTTP Request (REST) Operation
  if (operation === "http_request") {
    const targetUrl = asString(rawArgs.url, "").trim();
    if (!targetUrl) {
      return {
        tool: "OmnIA",
        operation: "http_request",
        status: "error",
        error: "Missing required 'url' parameter for http_request.",
        executionMs: Date.now() - startTime,
      };
    }

    // Permission: Check domain
    const domainCheck = isDomainAllowed(targetUrl, permissions);
    if (!domainCheck.allowed) {
      return {
        tool: "OmnIA",
        operation: "http_request",
        status: "permission_denied",
        error: domainCheck.reason,
        policy: {
          mode: permissions.mode,
          allowedDomains: permissions.allowedDomains,
          allowedMethods: permissions.allowedMethods,
        },
        executionMs: Date.now() - startTime,
        guidance: "OmnIA blocked this endpoint due to permission restrictions. Explain the restriction politely to the user.",
      };
    }

    // Permission: Check method
    const method = asString(rawArgs.method, "GET").toUpperCase();
    const methodCheck = isMethodAllowed(method, permissions, false);
    if (!methodCheck.allowed) {
      return {
        tool: "OmnIA",
        operation: "http_request",
        status: "permission_denied",
        error: methodCheck.reason,
        policy: {
          mode: permissions.mode,
          allowedDomains: permissions.allowedDomains,
          allowedMethods: permissions.allowedMethods,
        },
        executionMs: Date.now() - startTime,
      };
    }

    // Prepare headers & auto-inject auth token if available
    const customHeaders: Record<string, string> = {};
    if (permissions.authToken) {
      customHeaders.Authorization = `Bearer ${permissions.authToken}`;
    }
    if (typeof rawArgs.headers === "object" && rawArgs.headers !== null) {
      for (const [k, v] of Object.entries(rawArgs.headers)) {
        if (typeof v === "string") customHeaders[k] = v;
      }
    }

    try {
      const res = await executeRestEndpoint({
        url: targetUrl,
        method,
        queryParams: (rawArgs.params as Record<string, unknown>) || {},
        body: rawArgs.body,
        headers: customHeaders,
        auth: permissions.authToken ? { type: "bearer", token: permissions.authToken } : undefined,
      });

      return {
        tool: "OmnIA",
        operation: "http_request",
        status: res.success ? "success" : "error",
        statusCode: res.status,
        data: res.data,
        error: res.error,
        executionMs: Date.now() - startTime,
        guidance: "OmnIA HTTP response received. Synthesize the returned data and explain the outcome clearly to the user.",
      };
    } catch (err) {
      return {
        tool: "OmnIA",
        operation: "http_request",
        status: "error",
        error: `OmnIA http_request execution failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  // 3. GraphQL Query Operation
  if (operation === "graphql_query") {
    const targetUrl = asString(rawArgs.url || config.graphql_endpoint_url, "").trim();
    if (!targetUrl) {
      return {
        tool: "OmnIA",
        operation: "graphql_query",
        status: "error",
        error: "Missing required 'url' or configured graphql_endpoint_url for graphql_query.",
        executionMs: Date.now() - startTime,
      };
    }

    const domainCheck = isDomainAllowed(targetUrl, permissions);
    if (!domainCheck.allowed) {
      return {
        tool: "OmnIA",
        operation: "graphql_query",
        status: "permission_denied",
        error: domainCheck.reason,
        policy: {
          mode: permissions.mode,
          allowedDomains: permissions.allowedDomains,
          allowedMethods: permissions.allowedMethods,
        },
        executionMs: Date.now() - startTime,
      };
    }

    const query = asString(rawArgs.query, "").trim();
    if (!query) {
      return {
        tool: "OmnIA",
        operation: "graphql_query",
        status: "error",
        error: "Missing required 'query' string for graphql_query.",
        executionMs: Date.now() - startTime,
      };
    }

    const isMutation = /^\s*mutation\b/i.test(query);
    const methodCheck = isMethodAllowed("POST", permissions, isMutation);
    if (!methodCheck.allowed) {
      return {
        tool: "OmnIA",
        operation: "graphql_query",
        status: "permission_denied",
        error: methodCheck.reason,
        policy: {
          mode: permissions.mode,
          allowedDomains: permissions.allowedDomains,
          allowedMethods: permissions.allowedMethods,
        },
        executionMs: Date.now() - startTime,
      };
    }

    const customHeaders: Record<string, string> = {};
    if (permissions.authToken) {
      customHeaders.Authorization = `Bearer ${permissions.authToken}`;
    }
    if (typeof rawArgs.headers === "object" && rawArgs.headers !== null) {
      for (const [k, v] of Object.entries(rawArgs.headers)) {
        if (typeof v === "string") customHeaders[k] = v;
      }
    }

    try {
      const res = await executeGraphQL({
        url: targetUrl,
        query,
        variables: (rawArgs.variables as Record<string, unknown>) || {},
        headers: customHeaders,
      });

      return {
        tool: "OmnIA",
        operation: "graphql_query",
        status: res.success ? "success" : "error",
        data: res.data,
        error: res.errors
          ?.map((e: unknown) =>
            typeof e === "object" && e && "message" in e
              ? String((e as Record<string, unknown>).message)
              : String(e),
          )
          .join("; "),
        executionMs: Date.now() - startTime,
        guidance: "OmnIA GraphQL query completed. Process the data records and answer the user's questions with these details.",
      };
    } catch (err) {
      return {
        tool: "OmnIA",
        operation: "graphql_query",
        status: "error",
        error: `OmnIA GraphQL query execution failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  // 4. Inspect API Documentation Operation
  if (operation === "inspect_api") {
    const target = asString(rawArgs.url || config.openapi_spec_url || config.graphql_endpoint_url, "").trim();
    if (!target) {
      return {
        tool: "OmnIA",
        operation: "inspect_api",
        status: "error",
        error: "Missing required target URL or file path for inspect_api.",
        executionMs: Date.now() - startTime,
      };
    }

    if (/^https?:\/\//i.test(target)) {
      const domainCheck = isDomainAllowed(target, permissions);
      if (!domainCheck.allowed) {
        return {
          tool: "OmnIA",
          operation: "inspect_api",
          status: "permission_denied",
          error: domainCheck.reason,
          executionMs: Date.now() - startTime,
        };
      }
    }

    try {
      // Check if GraphQL endpoint or OpenAPI spec
      if (rawArgs.query || target.endsWith("/graphql") || target.includes("graphql")) {
        const schema = await introspectGraphQLSchema(target);
        const docs = formatGraphQLDocs(schema);
        return {
          tool: "OmnIA",
          operation: "inspect_api",
          status: "success",
          data: { type: "graphql", summary: docs },
          executionMs: Date.now() - startTime,
          guidance: "OmnIA GraphQL schema inspected. Use this schema understanding to construct subsequent queries.",
        };
      }

      const spec = await loadOpenApiSpec(target);
      const docs = formatOpenApiDocs(spec);
      return {
        tool: "OmnIA",
        operation: "inspect_api",
        status: "success",
        data: { type: "openapi", title: spec.title, version: spec.version, endpointsCount: spec.operations.length, summary: docs },
        executionMs: Date.now() - startTime,
        guidance: "OmnIA OpenAPI specification analyzed. Formulate your subsequent calls or explanations accordingly.",
      };
    } catch (err) {
      return {
        tool: "OmnIA",
        operation: "inspect_api",
        status: "error",
        error: `OmnIA inspect_api failed: ${err instanceof Error ? err.message : String(err)}`,
        executionMs: Date.now() - startTime,
      };
    }
  }

  return {
    tool: "OmnIA",
    operation,
    status: "error",
    error: `Unknown OmnIA operation: "${operation}". Supported operations: ip_location, http_request, graphql_query, inspect_api.`,
    executionMs: Date.now() - startTime,
  };
}

// ── Unified Tool Definition (OmnIA) ─────────────────────────────────────────

export const OMNIA_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "omnia",
    description:
      "OmnIA: Unified tool engine for network data retrieval, IP geolocation, REST API calls, and GraphQL operations with permission controls. " +
      "Use this to query external endpoints, get public IP and geographic location, or inspect API documentation.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["ip_location", "http_request", "graphql_query", "inspect_api"],
          description:
            "Operation to execute: 'ip_location' for IP/location discovery; 'http_request' for REST API endpoints; 'graphql_query' for GraphQL queries; 'inspect_api' to inspect OpenAPI/GraphQL documentation.",
        },
        url: {
          type: "string",
          description: "Target URL or endpoint (required for http_request, graphql_query, and inspect_api).",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method for http_request (default: GET).",
        },
        params: {
          type: "object",
          description: "URL query parameters as key-value pairs (e.g. { \"format\": \"json\" }).",
        },
        headers: {
          type: "object",
          description: "Custom HTTP headers object (e.g. { \"Accept\": \"application/json\" }).",
        },
        body: {
          type: "object",
          description: "JSON request body payload for POST/PUT/PATCH requests.",
        },
        query: {
          type: "string",
          description: "GraphQL query or mutation document for graphql_query.",
        },
        variables: {
          type: "object",
          description: "Variables map for GraphQL query.",
        },
        ip: {
          type: "string",
          description: "Optional specific IP address to geolocate for ip_location (default: current public IP).",
        },
        notes: {
          type: "string",
          description: "Brief note explaining the goal of this invocation.",
        },
      },
      required: ["operation"],
    },
  },
};

// ── Specialized Aliases for Granular Discovery ──────────────────────────────

export const OMNIA_IP_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "omnia_ip_location",
    description: "OmnIA: Fetches current public IP, geographical location, city, region, ISP, and coordinates.",
    parameters: {
      type: "object",
      properties: {
        ip: {
          type: "string",
          description: "Optional specific IP address to inspect (default: current public connection IP).",
        },
      },
    },
  },
};

export const OMNIA_HTTP_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "omnia_http_request",
    description: "OmnIA: Executes an authorized HTTP/REST request to a permitted domain.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target API endpoint URL." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method (default: GET).",
        },
        params: { type: "object", description: "Query string parameters." },
        headers: { type: "object", description: "Request headers." },
        body: { type: "object", description: "JSON request body for POST/PUT/PATCH." },
      },
      required: ["url"],
    },
  },
};

export const OMNIA_GRAPHQL_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "omnia_graphql",
    description: "OmnIA: Executes a GraphQL query against a target GraphQL endpoint.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target GraphQL endpoint URL." },
        query: { type: "string", description: "GraphQL query string." },
        variables: { type: "object", description: "GraphQL variables map." },
        headers: { type: "object", description: "Optional custom request headers." },
      },
      required: ["query"],
    },
  },
};

export const OMNIA_INSPECT_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "omnia_inspect_docs",
    description: "OmnIA: Inspects OpenAPI (Swagger) or GraphQL schemas to discover available operations and parameters.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "OpenAPI JSON/YAML spec URL or GraphQL endpoint URL." },
      },
      required: ["url"],
    },
  },
};

/**
 * Standard OmnIA toolset exposed to models.
 * Combines the primary `omnia` engine tool and specialized aliases.
 */
export const OMNIA_TOOLS = [
  OMNIA_TOOL_DEFINITION,
  OMNIA_IP_TOOL_DEFINITION,
  OMNIA_HTTP_TOOL_DEFINITION,
  OMNIA_GRAPHQL_TOOL_DEFINITION,
  OMNIA_INSPECT_TOOL_DEFINITION,
];
