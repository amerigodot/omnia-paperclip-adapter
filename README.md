# OmnIA Paperclip Adapter (`omnia-paperclip-adapter`)

Decoupled external adapter plugin for **Paperclip** that enables sovereign, local LLM execution via **Ollama** and **OmnIA Governance & Security Engine**, featuring:
- Full **Open WebUI-compliant** model parameter configuration.
- Real-time streaming token output with structured tool call and tool result logging (`ui-parser.js`).
- **OmnIA Governance & Granular Tool Registry**:
  - Declarative Tool Registry (`omnia_tools`) in YAML/JSON with per-tool enable/disable switches.
  - Granular access controls (pinned `url`, `baseUrl`, allowed HTTP methods, path patterns).
  - Individual authentication schemes (`bearer`, `api_key`, `basic`, `hmac`).
  - No mandatory domain whitelist; default SSRF safety against private networks.
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

## Tool Architecture: Registry & Model Execution

OmnIA decouples **tool governance (Control Plane)** from **model execution (Runtime)**:

```
┌────────────────────────────────────────────────────────┐
│             Tool Registry (omnia_tools)                 │
│  - Declare tools (built-in or custom)                  │
│  - Individual enable/disable toggles                   │
│  - Dedicated access parameters (URL, allowed methods)  │
│  - Individual credentials (Bearer, API Key, Basic)     │
└───────────────────────────┬────────────────────────────┘
                            │
              Filters only enabled tools
                            ▼
┌────────────────────────────────────────────────────────┐
│             Model Function-Calling Runtime             │
│  - Only active tools are exposed to Ollama (qwen3, ...)│
│  - Model calls tool by name with arguments             │
│  - OmnIA injects credentials & enforces permissions    │
└────────────────────────────────────────────────────────┘
```

---

### 1. Declarative Tool Registry (`omnia_tools`)

Rather than relying on a rigid global domain whitelist, OmnIA uses a **declarative Tool Registry** (supported in both **YAML** and **JSON**).

This enables:
1. **Clear Tool Identification**: Each tool has an explicit name, human-readable label, and LLM guidance description.
2. **Add / Remove Tools**: Add arbitrary new API endpoints or remove unwanted default tools.
3. **Enable / Disable Toggles**: Toggle individual tools on/off (`enabled: true | false`) without deleting their configuration. Disabled tools are completely excluded from the model prompt and rejected if invoked.
4. **Individual Access Parameters**:
   - `url` or `baseUrl`: Pinned target endpoint URL or permitted base URL prefix.
   - `allowedMethods`: Permitted HTTP methods specifically for that tool (e.g. `["GET"]` for read-only, `["POST"]` for webhooks).
   - `allowedPaths`: Optional path pattern whitelist.
   - `timeoutMs`: Tool-specific timeout.
5. **Individual Authentication**: Configure credentials per tool (`bearer`, `api_key`, `basic`, `hmac`), resolving from environment variables (`tokenEnv`, `keyEnv`) or direct values.
6. **No Mandatory Whitelist**: Public targets can be accessed cleanly based on tool configuration without requiring an arbitrary non-empty global domain whitelist.

#### Example Tool Registry Configuration (YAML)

```yaml
# 1. IP Location Inspector
- name: ip_location
  label: "IP & Geolocation Inspector"
  description: "Inspects public IP and geographical location details."
  type: ip_location
  enabled: true

# 2. General REST API Client (Open endpoint discovery)
- name: call_api_endpoint
  label: "REST API Client"
  description: "Executes HTTP requests to API endpoints."
  type: http_request
  enabled: true
  access:
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"]

# 3. Dedicated Custom Tool: GitHub Issues (Pre-bound URL & Private Auth)
- name: get_github_issues
  label: "GitHub Issues Reader"
  description: "Query open issues and PRs from Paperclip repository."
  type: http_request
  enabled: true
  access:
    url: "https://api.github.com/repos/paperclipai/paperclip/issues"
    allowedMethods: ["GET"]
  auth:
    type: bearer
    tokenEnv: "GITHUB_TOKEN"

# 4. GraphQL Query Tool (Disabled in settings)
- name: query_graphql
  label: "GraphQL Client"
  description: "Executes GraphQL queries and mutations."
  type: graphql
  enabled: false  # Disabled: completely hidden from the model prompt
  access:
    allowedMethods: ["POST"]

# 5. API Documentation Inspector
- name: inspect_api_documentation
  label: "API Documentation Inspector"
  description: "Inspects OpenAPI specifications or GraphQL schemas."
  type: inspect_api
  enabled: true
```

---

### 2. Runtime: What Models See & Invocations

When an agent runs, OmnIA projects **only the enabled tools** into Ollama's function-calling schema. The model then invokes tools using structured JSON arguments.

Below are the invocation signatures for the primary tool engines:

#### A. Dedicated / Scoped REST Tool (e.g. `get_github_issues`)
When a tool has a pre-bound URL and auth configured in the Registry, the model invocation is simple and safe—the model does not need to know the target URL or authentication secret:

```json
{
  "name": "get_github_issues",
  "arguments": {
    "params": {
      "state": "open",
      "per_page": 5
    }
  }
}
```
*OmnIA automatically resolves `GITHUB_TOKEN`, attaches `Authorization: Bearer ...`, calls `https://api.github.com/repos/paperclipai/paperclip/issues`, and returns the parsed result.*

#### B. General REST Tool (`call_api_endpoint`)
For open REST execution across permitted endpoints:

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
    }
  }
}
```

#### C. GraphQL Tool (`query_graphql`)
Executes a GraphQL query or mutation:

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

#### D. Schema Inspector (`inspect_api_documentation`)
Inspects and summarizes OpenAPI (Swagger) specifications or GraphQL schemas:

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

#### E. IP & Geolocation Inspector (`ip_location`)
Inspects current connection IP and geographical location:

```json
{
  "name": "ip_location",
  "arguments": {
    "ip": "myip"
  }
}
```

---

## Security Modes

OmnIA provides 4 operational security tiers:

| Mode | Allowed HTTP Methods | Domain Policy | Tool Calls Permitted |
|---|---|---|---|
| `permissive` | All (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, GraphQL queries & mutations) | Any domain | All |
| `read_only` | Safe methods only (`GET`, `HEAD`, `OPTIONS`, GraphQL queries) | Any domain | Read-only |
| `restricted` | Safe methods only (`GET`, `HEAD`, `OPTIONS`, GraphQL queries) | Whitelist only (`allowedDomains`) | Read-only on whitelisted domains |
| `disabled` | None | None | None (all tool invocations blocked) |

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

## Installation & Paperclip Integration

Paperclip allows decoupled external adapters to reside anywhere on disk or in remote registries. Choose one of the following methods:

### Method A: Declarative via `~/.paperclip/adapter-plugins.json` (Recommended for Local Dev)
Paperclip persists external adapters in `~/.paperclip/adapter-plugins.json`. Clone or copy this repository to any folder on your machine (completely outside Paperclip), build it, and register its absolute path:

```bash
git clone https://github.com/amerigodot/omnia-paperclip-adapter.git
cd omnia-paperclip-adapter
npm install
npm run build
```

Then add the entry to `~/.paperclip/adapter-plugins.json`:

```json
[
  {
    "packageName": "omnia-paperclip-adapter",
    "localPath": "/absolute/path/to/omnia-paperclip-adapter",
    "type": "omnia"
  }
]
```
When Paperclip starts, the plugin loader automatically loads the adapter from `localPath`.

---

### Method B: Dynamic Runtime via REST API (`/api/adapters/install`)
If Paperclip is already running, you can register and hot-load the local adapter without manual config file edits or restarting the server:

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "/absolute/path/to/omnia-paperclip-adapter",
    "isLocalPath": true
  }'
```

Paperclip validates `package.json`, updates `adapter-plugins.json`, and loads the `omnia` adapter type immediately into memory.

---

### Method C: via npm / Remote Registry (Production & Multi-Machine)
If published to npm or an internal/private package registry:

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "omnia-paperclip-adapter"
  }'
```
Paperclip downloads and installs the package into `~/.paperclip/adapter-plugins/node_modules/` and registers the adapter automatically.

---

## Agent Configuration in Paperclip

```json
{
  "adapterType": "omnia",
  "adapterConfig": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3:8b",
    "temperature": 0.2,
    "num_ctx": 8192,
    "enable_ip_tool": true,
    "enable_custom_api_tools": true,
    "security_mode": "restricted",
    "allowed_domains": ["api.github.com", "countries.trevorblades.com"]
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

---

## License

MIT License. See [LICENSE](LICENSE) for details.

