import { executeRestEndpoint, loadOpenApiSpec, formatOpenApiDocs, type EndpointExecutionResult } from "./openapi.js";
import { executeGraphQL, introspectGraphQLSchema, formatGraphQLDocs, type GraphQLExecutionResult } from "./graphql.js";
import type { AuthConfig } from "./auth.js";

export const CALL_API_ENDPOINT_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "call_api_endpoint",
    description:
      "Call an arbitrary REST API endpoint with path interpolation, query parameters, custom headers, JSON body, and authentication (Bearer, API Key, Basic Auth, or HMAC).",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full target URL or endpoint path (e.g. 'https://api.example.com/v1/users/{id}' or 'http://localhost:3000/api/items').",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
          description: "HTTP method to use (default: GET).",
        },
        path_params: {
          type: "object",
          description: "Key-value dictionary to interpolate into {param} or :param placeholders in the URL.",
        },
        query_params: {
          type: "object",
          description: "Key-value query parameters to append to the URL.",
        },
        headers: {
          type: "object",
          description: "Optional custom HTTP headers.",
        },
        body: {
          type: "object",
          description: "Optional request body (JSON object or array) for POST, PUT, or PATCH requests.",
        },
        auth: {
          type: "object",
          description:
            "Optional authentication config: {type: 'bearer', tokenEnv: 'VAR'} or {type: 'api_key', headerName: 'X-Key', keyEnv: 'VAR'} or {type: 'basic', userEnv: 'U', passEnv: 'P'} or {type: 'hmac', secretEnv: 'SEC', algorithm: 'sha256'}.",
        },
      },
      required: ["url"],
    },
  },
} as const;

export const QUERY_GRAPHQL_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "query_graphql",
    description:
      "Execute a GraphQL query or mutation against a GraphQL endpoint with variable support and authentication.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The GraphQL endpoint URL (e.g. 'https://api.spacex.land/graphql' or 'http://127.0.0.1:4000/graphql').",
        },
        query: {
          type: "string",
          description: "The GraphQL query or mutation string to execute.",
        },
        variables: {
          type: "object",
          description: "Optional key-value variables map for the GraphQL query.",
        },
        operation_name: {
          type: "string",
          description: "Optional operation name if multiple operations are defined in the query document.",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers.",
        },
        auth: {
          type: "object",
          description:
            "Optional authentication config: {type: 'bearer', tokenEnv: 'VAR'} or {type: 'api_key', headerName: 'X-Key', keyEnv: 'VAR'} or {type: 'basic', userEnv: 'U', passEnv: 'P'} or {type: 'hmac', secretEnv: 'SEC', algorithm: 'sha256'}.",
        },
      },
      required: ["url", "query"],
    },
  },
} as const;

export const INSPECT_API_DOCS_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "inspect_api_documentation",
    description:
      "Inspect API documentation and schema for OpenAPI (Swagger/REST) specifications or GraphQL endpoints. Discovers available endpoints, queries, mutations, parameters, and types.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["openapi", "graphql"],
          description: "Type of API documentation to inspect: 'openapi' for REST/Swagger, or 'graphql' for GraphQL.",
        },
        source: {
          type: "string",
          description:
            "For OpenAPI: A URL pointing to an OpenAPI JSON/YAML spec, or a local file path. For GraphQL: The GraphQL endpoint URL to introspect.",
        },
        filter: {
          type: "string",
          description:
            "Optional filter keyword (e.g. an endpoint path, operationId, query name, or type name) to retrieve detailed docs.",
        },
        auth: {
          type: "object",
          description: "Optional authentication config if the documentation endpoint is protected.",
        },
      },
      required: ["type", "source"],
    },
  },
} as const;

export const GENERIC_API_TOOLS = [
  CALL_API_ENDPOINT_TOOL_DEFINITION,
  QUERY_GRAPHQL_TOOL_DEFINITION,
  INSPECT_API_DOCS_TOOL_DEFINITION,
];

/**
 * Normalizes raw tool arguments from LLM into typed AuthConfig.
 */
function normalizeAuth(rawAuth: unknown): AuthConfig | null {
  if (!rawAuth || typeof rawAuth !== "object") return null;
  const obj = rawAuth as Record<string, unknown>;
  const type = String(obj.type || obj.authType || "").toLowerCase();

  if (type === "bearer") {
    return {
      type: "bearer",
      tokenEnv: typeof obj.tokenEnv === "string" ? obj.tokenEnv : typeof obj.token_env === "string" ? obj.token_env : undefined,
      token: typeof obj.token === "string" ? obj.token : undefined,
    };
  }

  if (type === "api_key" || type === "apikey") {
    return {
      type: "api_key",
      headerName: typeof obj.headerName === "string" ? obj.headerName : typeof obj.header_name === "string" ? obj.header_name : undefined,
      keyEnv: typeof obj.keyEnv === "string" ? obj.keyEnv : typeof obj.key_env === "string" ? obj.key_env : undefined,
      key: typeof obj.key === "string" ? obj.key : undefined,
      in: obj.in === "query" ? "query" : "header",
      paramName: typeof obj.paramName === "string" ? obj.paramName : typeof obj.param_name === "string" ? obj.param_name : undefined,
    };
  }

  if (type === "basic") {
    return {
      type: "basic",
      userEnv: typeof obj.userEnv === "string" ? obj.userEnv : typeof obj.user_env === "string" ? obj.user_env : undefined,
      passEnv: typeof obj.passEnv === "string" ? obj.passEnv : typeof obj.pass_env === "string" ? obj.pass_env : undefined,
      username: typeof obj.username === "string" ? obj.username : undefined,
      password: typeof obj.password === "string" ? obj.password : undefined,
    };
  }

  if (type === "hmac") {
    return {
      type: "hmac",
      secretEnv: typeof obj.secretEnv === "string" ? obj.secretEnv : typeof obj.secret_env === "string" ? obj.secret_env : undefined,
      secret: typeof obj.secret === "string" ? obj.secret : undefined,
      algorithm: obj.algorithm === "sha512" ? "sha512" : "sha256",
      headerName: typeof obj.headerName === "string" ? obj.headerName : typeof obj.header_name === "string" ? obj.header_name : undefined,
      timestampHeader: typeof obj.timestampHeader === "string" ? obj.timestampHeader : typeof obj.timestamp_header === "string" ? obj.timestamp_header : undefined,
      includeBody: Boolean(obj.includeBody ?? obj.include_body),
    };
  }

  return null;
}

/**
 * Executes call_api_endpoint tool.
 */
export async function handleCallApiEndpoint(
  args: Record<string, unknown>,
): Promise<EndpointExecutionResult> {
  const url = String(args.url || "").trim();
  if (!url) {
    return {
      url: "",
      method: "GET",
      status: 400,
      statusText: "Bad Request",
      success: false,
      headers: {},
      data: null,
      durationMs: 0,
      error: "Missing required parameter 'url'.",
    };
  }

  const method = typeof args.method === "string" ? args.method : "GET";
  const pathParams = (args.path_params ?? args.pathParams) as Record<string, unknown> | undefined;
  const queryParams = (args.query_params ?? args.queryParams) as Record<string, unknown> | undefined;
  const headers = (args.headers ?? {}) as Record<string, string>;
  const body = args.body;
  const auth = normalizeAuth(args.auth);

  return executeRestEndpoint({
    url,
    method,
    pathParams,
    queryParams,
    headers,
    body,
    auth,
  });
}

/**
 * Executes query_graphql tool.
 */
export async function handleQueryGraphQL(
  args: Record<string, unknown>,
): Promise<GraphQLExecutionResult> {
  const url = String(args.url || "").trim();
  const query = String(args.query || "").trim();

  if (!url || !query) {
    return {
      url: url || "",
      success: false,
      status: 400,
      durationMs: 0,
      errorMessage: "Missing required parameters 'url' and/or 'query'.",
    };
  }

  const variables = args.variables as Record<string, unknown> | undefined;
  const operationName = (args.operation_name ?? args.operationName) as string | undefined;
  const headers = (args.headers ?? {}) as Record<string, string>;
  const auth = normalizeAuth(args.auth);

  return executeGraphQL({
    url,
    query,
    variables,
    operationName,
    headers,
    auth,
  });
}

/**
 * Executes inspect_api_documentation tool.
 */
export async function handleInspectApiDocs(
  args: Record<string, unknown>,
): Promise<{ success: boolean; type: string; source: string; documentation?: string; error?: string }> {
  const type = String(args.type || "").trim().toLowerCase();
  const source = String(args.source || "").trim();
  const filter = typeof args.filter === "string" ? args.filter : undefined;
  const auth = normalizeAuth(args.auth);

  if (!source) {
    return {
      success: false,
      type,
      source: "",
      error: "Missing required parameter 'source'.",
    };
  }

  if (type === "openapi" || type === "swagger" || type === "rest") {
    try {
      const spec = await loadOpenApiSpec(source, auth);
      const documentation = formatOpenApiDocs(spec, filter);
      return {
        success: true,
        type: "openapi",
        source,
        documentation,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        type: "openapi",
        source,
        error: `Failed to inspect OpenAPI documentation: ${message}`,
      };
    }
  }

  if (type === "graphql") {
    try {
      const schema = await introspectGraphQLSchema(source, auth);
      const documentation = formatGraphQLDocs(schema, filter);
      return {
        success: true,
        type: "graphql",
        source,
        documentation,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        type: "graphql",
        source,
        error: `Failed to inspect GraphQL schema: ${message}`,
      };
    }
  }

  return {
    success: false,
    type,
    source,
    error: `Unsupported documentation type '${type}'. Expected 'openapi' or 'graphql'.`,
  };
}
