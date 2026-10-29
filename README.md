# Ollama Paperclip Adapter (`ollama_local`)

Decoupled external adapter plugin for **Paperclip** that enables sovereign, local LLM execution via **Ollama**, featuring:
- Full **Open WebUI-compliant** model parameter configuration.
- Real-time streaming token output with structured tool call and tool result logging (`ui-parser.js`).
- Dual-step **IP & Geolocation inspection tool** (`get_ip_location`).
- **Generic Custom API & Connector Tooling**:
  - **REST / OpenAPI**: Dynamic endpoint execution (`call_api_endpoint`) with URL path interpolation, query parameters, custom headers, and payload formatting.
  - **OpenAPI Documentation Inspection** (`inspect_api_documentation`): Loads, parses, and summarizes OpenAPI 3.x / Swagger 2.0 specifications (from remote URLs or local JSON/YAML files) into clean markdown for the model.
  - **GraphQL**: Query and mutation execution (`query_graphql`) with variables, operation names, and headers.
  - **GraphQL Schema Introspection** (`inspect_api_documentation`): Introspects GraphQL schemas via `__schema` to discover queries, mutations, types, arguments, and return types.
  - **Elastic Authentication**:
    - `bearer`: Bearer token resolved from `tokenEnv` or direct token.
    - `api_key`: API key in header (`headerName`) or query parameter, resolved from `keyEnv` or direct key.
    - `basic`: HTTP Basic authentication (`userEnv` / `passEnv`).
    - `hmac`: HMAC signature (`secretEnv`, algorithm `sha256` | `sha512`) with automatic `X-Timestamp` and `X-Signature` generation.

---

## Tools Available to Models

When configured, the adapter exposes function tools to models that support function calling (`qwen3:8b`, `gemma4`, `llama3.1`, etc.):

### 1. `call_api_endpoint`
Executes an arbitrary REST API endpoint.

```json
{
  "name": "call_api_endpoint",
  "arguments": {
    "url": "https://api.github.com/repos/{owner}/{repo}/issues",
    "method": "GET",
    "path_params": {
      "owner": "paperclipai",
      "repo": "paperclip"
    },
    "query_params": {
      "state": "open",
      "per_page": 5
    },
    "auth": {
      "type": "bearer",
      "tokenEnv": "GITHUB_TOKEN"
    }
  }
}
```

### 2. `query_graphql`
Executes a GraphQL query or mutation.

```json
{
  "name": "query_graphql",
  "arguments": {
    "url": "https://countries.trevorblades.com/graphql",
    "query": "query GetCountry($code: ID!) { country(code: $code) { name capital currency emoji } }",
    "variables": {
      "code": "IT"
    }
  }
}
```

### 3. `inspect_api_documentation`
Inspects and summarizes API documentation for either OpenAPI specs or GraphQL endpoints.

```json
// For OpenAPI (Swagger):
{
  "name": "inspect_api_documentation",
  "arguments": {
    "type": "openapi",
    "source": "https://petstore.swagger.io/v2/swagger.json",
    "filter": "pet"
  }
}

// For GraphQL:
{
  "name": "inspect_api_documentation",
  "arguments": {
    "type": "graphql",
    "source": "https://api.spacex.land/graphql",
    "filter": "launch"
  }
}
```

### 4. `get_ip_location`
Inspects external public IP and geolocation details using `api.ipify.org` + `ipwho.is` / `ip-api.com`.

```json
{
  "name": "get_ip_location",
  "arguments": {
    "ip": "myip"
  }
}
```

---

## Authentication Schemes

| Scheme | Config Schema | Resulting Header / Parameter |
|---|---|---|
| **Bearer** | `{ "type": "bearer", "tokenEnv": "VAR_NAME" }` | `Authorization: Bearer <token>` |
| **API Key (Header)** | `{ "type": "api_key", "headerName": "X-API-Key", "keyEnv": "VAR_NAME" }` | `X-API-Key: <key>` |
| **API Key (Query)** | `{ "type": "api_key", "in": "query", "paramName": "key", "keyEnv": "VAR_NAME" }` | `?key=<key>` |
| **Basic** | `{ "type": "basic", "userEnv": "USER_VAR", "passEnv": "PASS_VAR" }` | `Authorization: Basic <base64>` |
| **HMAC** | `{ "type": "hmac", "secretEnv": "SECRET_VAR", "algorithm": "sha256" }` | `X-Timestamp: <ts>`<br>`X-Signature: sha256=<hex>` |

---

## Agent Configuration in Paperclip

```json
{
  "adapterType": "ollama_local",
  "adapterConfig": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3:8b",
    "temperature": 0.2,
    "num_ctx": 8192,
    "enable_ip_tool": true,
    "enable_custom_api_tools": true,
    "openapi_spec_url": "https://petstore.swagger.io/v2/swagger.json",
    "graphql_endpoint_url": "https://countries.trevorblades.com/graphql"
  }
}
```

---

## Development & Testing

```bash
# Build TypeScript
npm run build

# Run Unit Tests
npm test
```
