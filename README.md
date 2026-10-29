# OmnIA Paperclip Adapter (`omnia-paperclip-adapter`)

Decoupled external adapter plugin for **Paperclip** that enables sovereign, local LLM execution via **Ollama** and **OmnIA Governance & Security Engine**, featuring:
- Full **Open WebUI-compliant** model parameter configuration.
- Real-time streaming token output with structured tool call and tool result logging (`ui-parser.js`).
- **OmnIA Governance & Security Mode Enforcement** (`permissive`, `read_only`, `restricted`, `disabled`):
  - Domain whitelisting (`allowedDomains`).
  - Read-only method restrictions (blocking POST/PUT/DELETE/PATCH/Mutations).
  - Explicit tool disabling.
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
Executes an arbitrary REST API endpoint subject to OmnIA security mode policies.

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
Executes a GraphQL query or mutation subject to OmnIA security mode policies.

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
