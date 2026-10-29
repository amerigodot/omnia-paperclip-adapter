import { describe, it, expect } from "vitest";
import http from "node:http";
import { resolveAuth } from "./auth.js";
import {
  loadOpenApiSpec,
  formatOpenApiDocs,
  executeRestEndpoint,
} from "./openapi.js";
import {
  executeGraphQL,
  introspectGraphQLSchema,
  formatGraphQLDocs,
  type ParsedGraphQLSchema,
} from "./graphql.js";
import {
  handleCallApiEndpoint,
  handleQueryGraphQL,
  handleInspectApiDocs,
  GENERIC_API_TOOLS,
} from "./custom-endpoint.js";

describe("Custom Endpoints & Auth Tooling", () => {
  describe("Authentication Mechanisms", () => {
    it("resolves Bearer authentication from env and inline", () => {
      process.env.TEST_BEARER_TOKEN = "secret-token-123";
      const fromEnv = resolveAuth({ type: "bearer", tokenEnv: "TEST_BEARER_TOKEN" });
      expect(fromEnv.headers["Authorization"]).toBe("Bearer secret-token-123");

      const inline = resolveAuth({ type: "bearer", token: "direct-token" });
      expect(inline.headers["Authorization"]).toBe("Bearer direct-token");
      delete process.env.TEST_BEARER_TOKEN;
    });

    it("resolves API Key in headers or query params", () => {
      process.env.TEST_API_KEY = "key-abc-456";
      const headerAuth = resolveAuth({
        type: "api_key",
        headerName: "X-Custom-Key",
        keyEnv: "TEST_API_KEY",
      });
      expect(headerAuth.headers["X-Custom-Key"]).toBe("key-abc-456");

      const queryAuth = resolveAuth({
        type: "api_key",
        paramName: "api_token",
        key: "inline-key",
        in: "query",
      });
      expect(queryAuth.queryParams["api_token"]).toBe("inline-key");
      delete process.env.TEST_API_KEY;
    });

    it("resolves Basic Authentication into base64 header", () => {
      process.env.TEST_USER = "admin";
      process.env.TEST_PASS = "p@ssword!";
      const basic = resolveAuth({
        type: "basic",
        userEnv: "TEST_USER",
        passEnv: "TEST_PASS",
      });
      const expected = `Basic ${Buffer.from("admin:p@ssword!").toString("base64")}`;
      expect(basic.headers["Authorization"]).toBe(expected);
      delete process.env.TEST_USER;
      delete process.env.TEST_PASS;
    });

    it("generates HMAC signature with timestamp header", () => {
      process.env.TEST_HMAC_SECRET = "super-secret-hmac-key";
      const hmac = resolveAuth(
        {
          type: "hmac",
          secretEnv: "TEST_HMAC_SECRET",
          algorithm: "sha256",
          headerName: "X-Signature",
        },
        { body: { action: "transfer" } },
      );

      expect(hmac.headers["X-Timestamp"]).toBeDefined();
      expect(hmac.headers["X-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
      delete process.env.TEST_HMAC_SECRET;
    });
  });

  describe("OpenAPI Specification Parsing & REST Execution", () => {
    const sampleSpecYaml = `
openapi: 3.0.0
info:
  title: Sample Store API
  version: 2.1.0
  description: API for managing items and users.
servers:
  - url: https://api.samplestore.test/v1
paths:
  /items/{itemId}:
    get:
      operationId: getItemById
      summary: Retrieve an item by unique identifier
      parameters:
        - name: itemId
          in: path
          required: true
          schema:
            type: string
        - name: includeDetails
          in: query
          required: false
          schema:
            type: boolean
      responses:
        "200":
          description: Item details
    put:
      operationId: updateItem
      summary: Update existing item
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                price:
                  type: number
      responses:
        "200":
          description: Updated item
`;

    it("parses OpenAPI YAML specification accurately", async () => {
      const parsed = await loadOpenApiSpec(sampleSpecYaml);
      expect(parsed.title).toBe("Sample Store API");
      expect(parsed.version).toBe("2.1.0");
      expect(parsed.baseUrl).toBe("https://api.samplestore.test/v1");
      expect(parsed.operations.length).toBe(2);

      const getOp = parsed.operations.find((o) => o.operationId === "getItemById");
      expect(getOp).toBeDefined();
      expect(getOp?.method).toBe("GET");
      expect(getOp?.parameters.length).toBe(2);
      expect(getOp?.parameters[0].name).toBe("itemId");
      expect(getOp?.parameters[0].in).toBe("path");
    });

    it("formats OpenAPI documentation into markdown for the LLM", async () => {
      const parsed = await loadOpenApiSpec(sampleSpecYaml);
      const docs = formatOpenApiDocs(parsed);
      expect(docs).toContain("# Sample Store API (v2.1.0)");
      expect(docs).toContain("GET /items/{itemId}");
      expect(docs).toContain("**OperationId:** `getItemById`");
      expect(docs).toContain("PUT /items/{itemId}");
    });

    it("interpolates path parameters and executes HTTP requests against a mock server", async () => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || "", `http://${req.headers.host}`);
        if (req.method === "GET" && url.pathname === "/items/item-99") {
          const queryParam = url.searchParams.get("includeDetails");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "item-99", name: "Laser Pointer", includeDetails: queryParam }));
          return;
        }
        res.writeHead(404);
        res.end("Not Found");
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      const result = await executeRestEndpoint({
        url: `http://127.0.0.1:${port}/items/{itemId}`,
        method: "GET",
        pathParams: { itemId: "item-99" },
        queryParams: { includeDetails: "true" },
      });

      server.close();

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect((result.data as { id: string }).id).toBe("item-99");
      expect((result.data as { includeDetails: string }).includeDetails).toBe("true");
    });
  });

  describe("GraphQL Execution & Introspection", () => {
    it("executes GraphQL queries with variables and headers against a mock GraphQL server", async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          if (parsed.query.includes("UserQuery")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                data: {
                  user: {
                    id: parsed.variables?.id || "unknown",
                    name: "Alice Hacker",
                    role: "Admin",
                  },
                },
              }),
            );
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errors: [{ message: "Unknown query" }] }));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      const result = await executeGraphQL({
        url: `http://127.0.0.1:${port}/graphql`,
        query: `
          query UserQuery($id: ID!) {
            user(id: $id) {
              id
              name
              role
            }
          }
        `,
        variables: { id: "user-42" },
      });

      server.close();

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect((result.data as any)?.user?.name).toBe("Alice Hacker");
      expect((result.data as any)?.user?.id).toBe("user-42");
    });

    it("safely omits operationName when executing anonymous queries to prevent GraphQL 400", async () => {
      let receivedPayload: any = null;
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          receivedPayload = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { status: "healthy" } }));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      const result = await executeGraphQL({
        url: `http://127.0.0.1:${port}/graphql`,
        query: `query { status }`,
        operationName: "status", // operationName provided by LLM but query is anonymous
      });

      server.close();

      expect(result.success).toBe(true);
      expect(receivedPayload.operationName).toBeUndefined();
    });

    it("formats GraphQL schema documentation into markdown", () => {
      const mockSchema: ParsedGraphQLSchema = {
        queryTypeName: "Query",
        queries: [
          {
            name: "launches",
            description: "List upcoming or past rocket launches",
            args: [{ name: "limit", type: "Int", description: "Max count" }],
            returnType: "[Launch]",
          },
        ],
        mutations: [
          {
            name: "scheduleLaunch",
            description: "Schedule a new launch",
            args: [{ name: "missionName", type: "String!" }],
            returnType: "LaunchResult",
          },
        ],
        types: {
          Launch: {
            name: "Launch",
            description: "Rocket launch data",
            fields: [
              { name: "id", type: "ID!" },
              { name: "missionName", type: "String!" },
            ],
          },
        },
      };

      const docs = formatGraphQLDocs(mockSchema);
      expect(docs).toContain("# GraphQL API Schema Documentation");
      expect(docs).toContain("launches(limit: Int): [Launch]");
      expect(docs).toContain("scheduleLaunch(missionName: String!): LaunchResult");
      expect(docs).toContain("type Launch {");
    });
  });

  describe("Custom Endpoint Tool Dispatcher", () => {
    it("exposes all 3 generic API tool definitions", () => {
      const names = GENERIC_API_TOOLS.map((t) => t.function.name);
      expect(names).toContain("call_api_endpoint");
      expect(names).toContain("query_graphql");
      expect(names).toContain("inspect_api_documentation");
    });

    it("handles inspect_api_documentation tool for OpenAPI", async () => {
      const sampleJson = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Pet Store", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List all pets",
              responses: { "200": { description: "Array of pets" } },
            },
          },
        },
      });

      const res = await handleInspectApiDocs({
        type: "openapi",
        source: sampleJson,
      });

      expect(res.success).toBe(true);
      expect(res.documentation).toContain("Pet Store");
      expect(res.documentation).toContain("GET /pets");
      expect(res.documentation).toContain("listPets");
    });

    it("handles call_api_endpoint with path parameter interpolation", async () => {
      const server = http.createServer((req, res) => {
        if (req.url === "/api/users/888") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ userId: 888, username: "neo" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      const res = await handleCallApiEndpoint({
        url: `http://127.0.0.1:${port}/api/users/{id}`,
        method: "GET",
        path_params: { id: 888 },
      });

      server.close();

      expect(res.success).toBe(true);
      expect((res.data as any)?.username).toBe("neo");
    });
  });
});
