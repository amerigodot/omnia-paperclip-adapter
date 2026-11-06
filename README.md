# OmnIA Paperclip Adapter (`@paperclipai/adapter-omnia`)

Sovereign AI Engine and Granular Governance Connector for **Paperclip**.
Connects Paperclip agents to remote sovereign LLM clusters (e.g. `https://api.ntv.cloud2local.com/omnia/api`) with dynamic model discovery, native streaming, per-agent dedicated tool suites, Git intelligence, and artifact generation.

---

## Architecture Overview

OmnIA decouples **governance and tool policies** (Control Plane) from **model inference** (Remote Sovereign Runtime):

```
┌────────────────────────────────────────────────────────────────────────┐
│                   OmnIA Control Plane (Paperclip UI & Server)           │
│  - Remote Endpoint: https://api.ntv.cloud2local.com/omnia/api           │
│  - Dynamic Model Discovery via /tags endpoint                          │
│  - Per-Agent Tool Registry & Execution Modes (Permissive, Read-Only)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Tool Invocations & Streaming Chat
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   OmnIA Runtime & Dedicated Tool Suite                 │
│  - Git Intelligence: Branch changelogs, tag ranges, beta refactors     │
│  - Artifact Publisher: Markdown reports & security audit artifacts    │
│  - IP & Geolocation: Public egress IP & datacenter verification        │
│  - REST & GraphQL Client: Dynamic HTTP / GraphQL introspection        │
│  - OpenAPI Inspector: Live schema loading & route summarization       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Deployment & Setup Guide

### Step 1: System Prerequisites
- **Node.js**: `>= 24.11.0` (or Node.js 26)
- **Package Manager**: `pnpm` (workspace mode)
- **Git**: Installed and accessible in `$PATH`
- **Remote Host**: Network connectivity to `https://api.ntv.cloud2local.com/omnia/api` (no local Ollama daemon required)

---

### Step 2: Build the OmnIA Adapter Package

From the repository root:

```bash
# Navigate to the adapter package directory
cd paperclip/packages/adapters/omnia

# Install dependencies (workspace-linked)
pnpm install

# Compile TypeScript to dist/
pnpm build

# Run the test suite (84 automated tests)
pnpm test
```

The package produces independent CJS/ESM artifacts in `dist/`, including `dist/ui-parser.js` for real-time streaming tool execution logs.

---

### Step 3: Run the Paperclip Daemon

In the root of the project:

```bash
# Run Paperclip server and UI (runs Vite + Express on http://127.0.0.1:3100)
./run-paperclip.sh
```

Embedded PostgreSQL automatically initializes on port `54329` and the web interface becomes available at `http://127.0.0.1:3100`.

---

### Step 4: Configure the OmnIA Adapter in Instance Settings

1. Open your browser and navigate to:
   ```
   http://127.0.0.1:3100/ARG/company/settings/instance/adapters
   ```
2. OmnIA is pinned at the very top of the Adapters list. Click **Configure** on the OmnIA card.
3. Verify or enter the remote endpoint URL:
   ```
   https://api.ntv.cloud2local.com/omnia/api
   ```
4. Click **Test** (or open the dialog for auto-testing):
   - The server probes `/tags` and `/api/tags` directly without duplicating `/api/api` paths.
   - Live models installed on the remote sovereign host are discovered dynamically:
     - `qwen3.8:latest` (27.3B, thinking + tools)
     - `deepseek-r1:14b` (Reasoning & chain-of-thought)
     - `qwen3.5:9b` (Tools + thinking)
     - `orcarouter/Qwen3.8-27B-Uncensored:latest`
     - `qwen3-vl:latest` (Vision-Language)
     - `gpt-oss:20b`
     - `qwen3-embedding:0.6b`
5. Select your default model (e.g. `qwen3.8:latest`) and click **Save Changes**.

---

### Step 5: Configure Per-Agent Dedicated Tools

Each agent maintains its own dedicated tool permissions without interfering with global engine settings.

1. Navigate to the agent's Tools tab:
   ```
   http://127.0.0.1:3100/ARG/agents/:agentId/tools
   (e.g., http://127.0.0.1:3100/ARG/agents/da/tools)
   ```
2. The **OmnIA Dedicated Tools** section allows granular configuration per agent:
   - **Git Intelligence & Changelog Analyzer** (`git_intelligence`): Generates branch diff summaries, inspects active refactoring across branches, and compares commit tag ranges.
   - **Artifact & Report Publisher** (`save_artifact`): Directly generates and stores persistent Markdown reports in Paperclip artifacts.
   - **IP & Geolocation Inspector** (`ip_location`): Verifies runtime environment IP and location.
   - **REST API Client** (`call_api_endpoint`): Makes authorized HTTP requests.
   - **GraphQL Client** (`query_graphql`): Queries and mutations.
   - **API Documentation Inspector** (`inspect_api_documentation`): Inspects OpenAPI specs and GraphQL schemas.
3. Select the **Execution Mode**:
   - `permissive`: All enabled tools are executable.
   - `read_only`: Only read-only tools and read requests (`GET`) are permitted.
   - `restricted`: Restricts high-risk and write operations.
4. Click **Save Tool Configuration**. Changes are saved directly to `agent.adapterConfig`.

---

### Step 6: Connectors & App Directory

1. Navigate to:
   ```
   http://127.0.0.1:3100/ARG/apps
   ```
2. **OmnIA Engine** is pinned at the top of the connectors directory with the **Pinned Engine** badge.
3. Clicking **Configure** redirects directly to the adapter management suite.

---

## Production Deployment Checklist

For headless servers and production deployments:

### Environment Variables
Configure the following in `/etc/environment` or your `.env` file:
```bash
# Paperclip Port
PORT=3100
HOST=127.0.0.1

# OmnIA Remote Sovereign Host
PAPERCLIP_OMNIA_HOST=https://api.ntv.cloud2local.com/omnia/api
OMNIA_KEY=your_optional_bearer_token

# Storage and Database paths
PAPERCLIP_INSTANCE_DIR=/Users/amerigodimaria/.paperclip/instances/default
```

### Process Management with Systemd or PM2
To keep Paperclip running persistently:
```bash
# Using PM2
pm2 start ./run-paperclip.sh --name paperclip-server
pm2 save
pm2 startup
```

---

## Unit Testing & Validation

Run comprehensive tests across all packages:
```bash
# Adapter unit tests
cd paperclip/packages/adapters/omnia && pnpm test

# UI integration tests
cd paperclip/ui && npx vitest run src/pages/AgentToolsTab.test.tsx src/pages/apps/Browse.test.tsx

# TypeScript typecheck
cd paperclip/server && npx tsc -b
cd paperclip/ui && npx vite build
```
