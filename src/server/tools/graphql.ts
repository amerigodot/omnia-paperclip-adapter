import { resolveAuth, type AuthConfig } from "./auth.js";

export interface GraphQLExecutionOptions {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  headers?: Record<string, string>;
  auth?: AuthConfig | null;
  timeoutMs?: number;
}

export interface GraphQLExecutionResult {
  url: string;
  success: boolean;
  status: number;
  data?: unknown;
  errors?: unknown[];
  durationMs: number;
  errorMessage?: string;
}

export const GRAPHQL_INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name
      kind
      description
      fields(includeDeprecated: true) {
        name
        description
        args {
          name
          description
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
          defaultValue
        }
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
}
`;

/**
 * Executes a GraphQL query or mutation over HTTP POST with variable binding and authentication.
 */
export async function executeGraphQL(
  opts: GraphQLExecutionOptions,
): Promise<GraphQLExecutionResult> {
  const startTime = Date.now();
  const url = opts.url.trim();

  const payload: Record<string, unknown> = {
    query: opts.query.trim(),
  };
  if (opts.variables && Object.keys(opts.variables).length > 0) {
    payload.variables = opts.variables;
  }
  if (opts.operationName && opts.operationName.trim()) {
    const trimmedOp = opts.operationName.trim();
    // Only forward operationName if the query document explicitly declares that named operation.
    // Standard GraphQL servers reject anonymous single queries if an extraneous operationName is sent.
    const hasNamedOp = new RegExp(`\\b(query|mutation|subscription)\\s+${trimmedOp}\\b`, "i").test(opts.query);
    if (hasNamedOp) {
      payload.operationName = trimmedOp;
    }
  }

  const resolvedAuth = resolveAuth(opts.auth, {
    body: payload,
    method: "POST",
    url,
  });

  const parsedUrl = new URL(url, "http://localhost");
  for (const [k, v] of Object.entries(resolvedAuth.queryParams)) {
    parsedUrl.searchParams.set(k, v);
  }

  const finalUrl = /^https?:\/\//i.test(url) ? parsedUrl.href : url;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...opts.headers,
    ...resolvedAuth.headers,
  };

  const timeoutMs = opts.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(finalUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const durationMs = Date.now() - startTime;
    const json = (await res.json().catch(() => null)) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
    } | null;

    if (!res.ok) {
      const errMsgs = json?.errors?.map((e) => e.message).filter(Boolean).join(", ") || res.statusText;
      return {
        url: finalUrl,
        success: false,
        status: res.status,
        data: json?.data,
        errors: json?.errors,
        durationMs,
        errorMessage: `HTTP ${res.status}: ${errMsgs}`,
      };
    }

    const hasErrors = Array.isArray(json?.errors) && json.errors.length > 0;
    const errorMessage = hasErrors
      ? json?.errors?.map((e) => e.message || "Unknown error").join("; ")
      : undefined;

    return {
      url: finalUrl,
      success: !hasErrors,
      status: res.status,
      data: json?.data,
      errors: json?.errors,
      durationMs,
      errorMessage,
    };
  } catch (err) {
    clearTimeout(timeout);
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    return {
      url: finalUrl,
      success: false,
      status: 0,
      durationMs,
      errorMessage: `GraphQL execution failed: ${message}`,
    };
  }
}

interface GraphQLTypeRef {
  kind?: string;
  name?: string;
  ofType?: GraphQLTypeRef;
}

function renderType(type?: GraphQLTypeRef): string {
  if (!type) return "unknown";
  if (type.kind === "NON_NULL") return `${renderType(type.ofType)}!`;
  if (type.kind === "LIST") return `[${renderType(type.ofType)}]`;
  return type.name || "unknown";
}

export interface ParsedGraphQLSchema {
  queryTypeName?: string;
  mutationTypeName?: string;
  queries: Array<{
    name: string;
    description?: string;
    args: Array<{ name: string; type: string; description?: string }>;
    returnType: string;
  }>;
  mutations: Array<{
    name: string;
    description?: string;
    args: Array<{ name: string; type: string; description?: string }>;
    returnType: string;
  }>;
  types: Record<string, {
    name: string;
    description?: string;
    fields: Array<{ name: string; type: string; description?: string }>;
  }>;
}

/**
 * Runs GraphQL introspection against the endpoint and structures the schema.
 */
export async function introspectGraphQLSchema(
  url: string,
  auth?: AuthConfig | null,
  headers?: Record<string, string>,
  timeoutMs = 12000,
): Promise<ParsedGraphQLSchema> {
  const result = await executeGraphQL({
    url,
    query: GRAPHQL_INTROSPECTION_QUERY,
    headers,
    auth,
    timeoutMs,
  });

  if (!result.success || !result.data) {
    throw new Error(`GraphQL Introspection failed: ${result.errorMessage || "No data returned."}`);
  }

  const rawSchema = (result.data as { __schema?: Record<string, unknown> }).__schema;
  if (!rawSchema) {
    throw new Error("Invalid GraphQL schema: __schema root not found.");
  }

  const queryTypeName = ((rawSchema.queryType as { name?: string })?.name) || "Query";
  const mutationTypeName = ((rawSchema.mutationType as { name?: string })?.name) || "Mutation";

  const rawTypes = (rawSchema.types as Array<Record<string, unknown>>) || [];
  const queries: ParsedGraphQLSchema["queries"] = [];
  const mutations: ParsedGraphQLSchema["mutations"] = [];
  const types: ParsedGraphQLSchema["types"] = {};

  for (const t of rawTypes) {
    const name = String(t.name ?? "");
    if (name.startsWith("__")) continue; // skip internal introspection types

    const fields = Array.isArray(t.fields) ? t.fields : [];
    const parsedFields = fields.map((f: Record<string, unknown>) => {
      const args = Array.isArray(f.args)
        ? f.args.map((a: Record<string, unknown>) => ({
            name: String(a.name ?? ""),
            type: renderType(a.type as GraphQLTypeRef),
            description: typeof a.description === "string" ? a.description : undefined,
          }))
        : [];

      return {
        name: String(f.name ?? ""),
        description: typeof f.description === "string" ? f.description : undefined,
        args,
        returnType: renderType(f.type as GraphQLTypeRef),
      };
    });

    if (name === queryTypeName) {
      for (const pf of parsedFields) {
        queries.push({
          name: pf.name,
          description: pf.description,
          args: pf.args,
          returnType: pf.returnType,
        });
      }
    } else if (name === mutationTypeName) {
      for (const pf of parsedFields) {
        mutations.push({
          name: pf.name,
          description: pf.description,
          args: pf.args,
          returnType: pf.returnType,
        });
      }
    } else if (t.kind === "OBJECT" || t.kind === "INTERFACE") {
      types[name] = {
        name,
        description: typeof t.description === "string" ? t.description : undefined,
        fields: parsedFields.map((f) => ({
          name: f.name,
          type: f.returnType,
          description: f.description,
        })),
      };
    }
  }

  return {
    queryTypeName,
    mutationTypeName,
    queries,
    mutations,
    types,
  };
}

/**
 * Formats a parsed GraphQL schema into structured markdown documentation for LLMs.
 */
export function formatGraphQLDocs(
  schema: ParsedGraphQLSchema,
  filter?: string,
): string {
  const lines: string[] = [];
  lines.push("# GraphQL API Schema Documentation\n");

  const filterNormalized = filter?.trim().toLowerCase();

  // Queries
  let queries = schema.queries;
  if (filterNormalized) {
    queries = queries.filter(
      (q) =>
        q.name.toLowerCase().includes(filterNormalized) ||
        q.description?.toLowerCase().includes(filterNormalized) ||
        q.returnType.toLowerCase().includes(filterNormalized),
    );
  }

  lines.push(`## Available Queries (${queries.length}):\n`);
  for (const q of queries) {
    const argsStr = q.args.length > 0
      ? `(${q.args.map((a) => `${a.name}: ${a.type}`).join(", ")})`
      : "";
    lines.push(`### \`${q.name}${argsStr}: ${q.returnType}\``);
    if (q.description) lines.push(`- **Description:** ${q.description}`);
    if (q.args.length > 0) {
      lines.push("- **Arguments:**");
      for (const arg of q.args) {
        lines.push(`  - \`${arg.name}\` (\`${arg.type}\`)${arg.description ? `: ${arg.description}` : ""}`);
      }
    }
    lines.push("");
  }

  // Mutations
  let mutations = schema.mutations;
  if (filterNormalized) {
    mutations = mutations.filter(
      (m) =>
        m.name.toLowerCase().includes(filterNormalized) ||
        m.description?.toLowerCase().includes(filterNormalized) ||
        m.returnType.toLowerCase().includes(filterNormalized),
    );
  }

  if (mutations.length > 0) {
    lines.push(`## Available Mutations (${mutations.length}):\n`);
    for (const m of mutations) {
      const argsStr = m.args.length > 0
        ? `(${m.args.map((a) => `${a.name}: ${a.type}`).join(", ")})`
        : "";
      lines.push(`### \`${m.name}${argsStr}: ${m.returnType}\``);
      if (m.description) lines.push(`- **Description:** ${m.description}`);
      if (m.args.length > 0) {
        lines.push("- **Arguments:**");
        for (const arg of m.args) {
          lines.push(`  - \`${arg.name}\` (\`${arg.type}\`)${arg.description ? `: ${arg.description}` : ""}`);
        }
      }
      lines.push("");
    }
  }

  // Types
  const typeNames = Object.keys(schema.types);
  let relevantTypes = typeNames;
  if (filterNormalized) {
    relevantTypes = typeNames.filter((t) => t.toLowerCase().includes(filterNormalized));
  }

  if (relevantTypes.length > 0 && (filterNormalized || relevantTypes.length <= 15)) {
    lines.push(`## Types (${relevantTypes.length}):\n`);
    for (const typeName of relevantTypes) {
      const t = schema.types[typeName];
      lines.push(`### Type \`${t.name}\``);
      if (t.description) lines.push(`- Description: ${t.description}`);
      lines.push("```graphql");
      lines.push(`type ${t.name} {`);
      for (const f of t.fields) {
        lines.push(`  ${f.name}: ${f.type}`);
      }
      lines.push("}");
      lines.push("```\n");
    }
  }

  return lines.join("\n");
}
