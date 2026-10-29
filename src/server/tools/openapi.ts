import fs from "node:fs/promises";
import yaml from "yaml";
import { resolveAuth, type AuthConfig } from "./auth.js";

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface OpenApiOperation {
  operationId?: string;
  path: string;
  method: string;
  summary?: string;
  description?: string;
  parameters: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    contentTypes: string[];
    schema?: Record<string, unknown>;
  };
  responses: Record<string, { description?: string }>;
}

export interface ParsedOpenApiSpec {
  title: string;
  version: string;
  description?: string;
  baseUrl: string;
  operations: OpenApiOperation[];
  raw: Record<string, unknown>;
}

/**
 * Loads and parses an OpenAPI (3.x or Swagger 2.0) specification from a URL, local file, or raw string.
 */
export async function loadOpenApiSpec(
  source: string,
  auth?: AuthConfig | null,
  timeoutMs = 8000,
): Promise<ParsedOpenApiSpec> {
  let content = source.trim();

  // If source is a URL, fetch it
  if (/^https?:\/\//i.test(source)) {
    const authHeaders = resolveAuth(auth).headers;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(source, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, application/yaml, text/yaml, */*",
        ...authHeaders,
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${source} (HTTP ${res.status}): ${await res.text()}`);
    }
    content = await res.text();
  } else if (!source.startsWith("{") && !source.startsWith("openapi") && !source.startsWith("swagger")) {
    // If not raw JSON/YAML, try reading from file
    try {
      content = await fs.readFile(source, "utf-8");
    } catch {
      // not a readable file, treat content as raw string
    }
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(content);
  } catch {
    try {
      doc = yaml.parse(content) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to parse OpenAPI document as JSON or YAML: ${err}`);
    }
  }

  if (!doc || typeof doc !== "object") {
    throw new Error("Invalid OpenAPI specification: root must be an object.");
  }

  return parseOpenApiDocument(doc, /^https?:\/\//i.test(source) ? source : undefined);
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return { $ref: ref };
  const parts = ref.slice(2).split("/");
  let curr: unknown = root;
  for (const part of parts) {
    if (curr === null || typeof curr !== "object") return undefined;
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr;
}

function dereferenceSchema(root: Record<string, unknown>, schema: unknown, depth = 0): unknown {
  if (depth > 5 || !schema || typeof schema !== "object") return schema;
  if ("$ref" in schema && typeof (schema as { $ref: unknown }).$ref === "string") {
    const resolved = resolveRef(root, (schema as { $ref: string }).$ref);
    return dereferenceSchema(root, resolved, depth + 1);
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => dereferenceSchema(root, item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    result[k] = dereferenceSchema(root, v, depth + 1);
  }
  return result;
}

/**
 * Parses raw OpenAPI object into structured ParsedOpenApiSpec.
 */
export function parseOpenApiDocument(
  doc: Record<string, unknown>,
  sourceUrl?: string,
): ParsedOpenApiSpec {
  const info = (doc.info ?? {}) as Record<string, unknown>;
  const title = String(info.title ?? "OpenAPI API");
  const version = String(info.version ?? "1.0.0");
  const description = typeof info.description === "string" ? info.description : undefined;

  let baseUrl = "";
  if (Array.isArray(doc.servers) && doc.servers.length > 0) {
    const firstServer = doc.servers[0] as { url?: string };
    if (firstServer?.url) baseUrl = firstServer.url;
  } else if (typeof doc.host === "string") {
    const schemes = Array.isArray(doc.schemes) && doc.schemes[0] ? String(doc.schemes[0]) : "https";
    const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
    baseUrl = `${schemes}://${doc.host}${basePath}`;
  }

  if ((!baseUrl || baseUrl.startsWith("/")) && sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      baseUrl = new URL(baseUrl || "/", parsed.origin).href;
    } catch {
      // ignore
    }
  }

  baseUrl = baseUrl.replace(/\/$/, "");

  const operations: OpenApiOperation[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const httpMethods = ["get", "post", "put", "delete", "patch", "options", "head"];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const commonParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of httpMethods) {
      const op = pathItem[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== "object") continue;

      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      const combinedParams = [...commonParams, ...opParams];

      const parameters: OpenApiParameter[] = combinedParams.map((p) => {
        const deref = (typeof p === "object" && p && "$ref" in p
          ? resolveRef(doc, (p as { $ref: string }).$ref)
          : p) as Record<string, unknown>;

        return {
          name: String(deref.name ?? ""),
          in: (deref.in as OpenApiParameter["in"]) ?? "query",
          required: Boolean(deref.required || deref.in === "path"),
          description: typeof deref.description === "string" ? deref.description : undefined,
          schema: deref.schema ? (dereferenceSchema(doc, deref.schema) as Record<string, unknown>) : undefined,
        };
      });

      let requestBody: OpenApiOperation["requestBody"];
      if (op.requestBody && typeof op.requestBody === "object") {
        const derefBody = (
          "$ref" in op.requestBody
            ? resolveRef(doc, (op.requestBody as { $ref: string }).$ref)
            : op.requestBody
        ) as Record<string, unknown>;

        const content = (derefBody.content ?? {}) as Record<string, { schema?: unknown }>;
        const contentTypes = Object.keys(content);
        const primarySchema = contentTypes.length > 0 ? content[contentTypes[0]]?.schema : undefined;

        requestBody = {
          required: Boolean(derefBody.required),
          description: typeof derefBody.description === "string" ? derefBody.description : undefined,
          contentTypes,
          schema: primarySchema ? (dereferenceSchema(doc, primarySchema) as Record<string, unknown>) : undefined,
        };
      }

      const responses: Record<string, { description?: string }> = {};
      if (op.responses && typeof op.responses === "object") {
        for (const [code, resp] of Object.entries(op.responses as Record<string, unknown>)) {
          if (resp && typeof resp === "object") {
            responses[code] = {
              description: typeof (resp as { description?: unknown }).description === "string"
                ? String((resp as { description: string }).description)
                : undefined,
            };
          }
        }
      }

      operations.push({
        operationId: typeof op.operationId === "string" ? op.operationId : undefined,
        path: pathStr,
        method: method.toUpperCase(),
        summary: typeof op.summary === "string" ? op.summary : undefined,
        description: typeof op.description === "string" ? op.description : undefined,
        parameters,
        requestBody,
        responses,
      });
    }
  }

  return {
    title,
    version,
    description,
    baseUrl,
    operations,
    raw: doc,
  };
}

/**
 * Formats parsed OpenAPI documentation into a clean, markdown representation for the model.
 */
export function formatOpenApiDocs(
  spec: ParsedOpenApiSpec,
  filter?: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title} (v${spec.version})`);
  if (spec.description) lines.push(spec.description);
  if (spec.baseUrl) lines.push(`**Base URL:** \`${spec.baseUrl}\`\n`);

  const filterNormalized = filter?.trim().toLowerCase();

  let ops = spec.operations;
  if (filterNormalized) {
    ops = spec.operations.filter(
      (op) =>
        op.operationId?.toLowerCase().includes(filterNormalized) ||
        op.path.toLowerCase().includes(filterNormalized) ||
        op.summary?.toLowerCase().includes(filterNormalized),
    );
  }

  if (ops.length === 0) {
    lines.push(`No operations found matching filter "${filter}".`);
    lines.push("\n### Available Endpoints Summary:");
    for (const op of spec.operations.slice(0, 30)) {
      lines.push(`- \`${op.method} ${op.path}\`${op.operationId ? ` (${op.operationId})` : ""}: ${op.summary ?? ""}`);
    }
    return lines.join("\n");
  }

  lines.push(`## Available Endpoints (${ops.length}):\n`);

  for (const op of ops) {
    lines.push(`### \`${op.method} ${op.path}\``);
    if (op.operationId) lines.push(`- **OperationId:** \`${op.operationId}\``);
    if (op.summary) lines.push(`- **Summary:** ${op.summary}`);
    if (op.description) lines.push(`- **Description:** ${op.description}`);

    if (op.parameters.length > 0) {
      lines.push("- **Parameters:**");
      for (const p of op.parameters) {
        const reqStr = p.required ? "*(required)*" : "*(optional)*";
        const typeStr = p.schema?.type ? `[${p.schema.type}]` : "";
        const descStr = p.description ? ` - ${p.description}` : "";
        lines.push(`  - \`${p.name}\` (${p.in}, ${typeStr}) ${reqStr}${descStr}`);
      }
    }

    if (op.requestBody) {
      const reqStr = op.requestBody.required ? "*(required)*" : "*(optional)*";
      lines.push(`- **Request Body:** ${reqStr} (Types: ${op.requestBody.contentTypes.join(", ")})`);
      if (op.requestBody.description) lines.push(`  - Description: ${op.requestBody.description}`);
      if (op.requestBody.schema) {
        lines.push(`  - Schema:\n\`\`\`json\n${JSON.stringify(op.requestBody.schema, null, 2)}\n\`\`\``);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

export interface ExecuteEndpointOptions {
  url: string;
  method?: string;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: AuthConfig | null;
  timeoutMs?: number;
}

export interface EndpointExecutionResult {
  url: string;
  method: string;
  status: number;
  statusText: string;
  success: boolean;
  headers: Record<string, string>;
  data: unknown;
  durationMs: number;
  error?: string;
}

/**
 * Executes a REST HTTP request with path interpolation, query serialization, auth headers, and response parsing.
 */
export async function executeRestEndpoint(
  opts: ExecuteEndpointOptions,
): Promise<EndpointExecutionResult> {
  const method = (opts.method || "GET").toUpperCase();
  const startTime = Date.now();
  let targetUrl = opts.url.trim();

  // 1. Interpolate path parameters e.g. /users/{id} or /items/:id
  if (opts.pathParams && typeof opts.pathParams === "object") {
    for (const [k, v] of Object.entries(opts.pathParams)) {
      const strVal = String(v ?? "");
      targetUrl = targetUrl.replace(new RegExp(`\\{${k}\\}`, "g"), encodeURIComponent(strVal));
      targetUrl = targetUrl.replace(new RegExp(`:${k}(?=/|$)`, "g"), encodeURIComponent(strVal));
    }
  }

  // 2. Resolve authentication
  const resolvedAuth = resolveAuth(opts.auth, {
    body: opts.body,
    method,
    url: targetUrl,
  });

  // 3. Attach query parameters
  const queryParams = {
    ...opts.queryParams,
    ...resolvedAuth.queryParams,
  };

  const parsedUrl = new URL(targetUrl, "http://localhost");
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== "") {
      if (Array.isArray(v)) {
        for (const item of v) parsedUrl.searchParams.append(k, String(item));
      } else {
        parsedUrl.searchParams.set(k, String(v));
      }
    }
  }

  const finalUrl = /^https?:\/\//i.test(targetUrl)
    ? parsedUrl.href
    : `${targetUrl.split("?")[0]}${parsedUrl.search}`;

  // 4. Headers
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    ...opts.headers,
    ...resolvedAuth.headers,
  };

  // 5. Body
  let requestBody: string | undefined;
  if (opts.body !== undefined && opts.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof opts.body === "string") {
      requestBody = opts.body;
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    } else {
      requestBody = JSON.stringify(opts.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
  }

  const timeoutMs = opts.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(finalUrl, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const durationMs = Date.now() - startTime;
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const contentType = res.headers.get("content-type") || "";
    let data: unknown;
    const rawText = await res.text();

    if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    } else {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    }

    return {
      url: finalUrl,
      method,
      status: res.status,
      statusText: res.statusText,
      success: res.ok,
      headers: responseHeaders,
      data,
      durationMs,
      ...(res.ok ? {} : { error: `HTTP ${res.status}: ${res.statusText}` }),
    };
  } catch (err) {
    clearTimeout(timeout);
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    return {
      url: finalUrl,
      method,
      status: 0,
      statusText: "Error",
      success: false,
      headers: {},
      data: null,
      durationMs,
      error: `Request failed: ${message}`,
    };
  }
}
