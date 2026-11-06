export const type = "omnia";
export const label = "OmnIA";

export const DEFAULT_OMNIA_ENDPOINT = "https://api.ntv.cloud2local.com/omnia/api";
export const DEFAULT_OLLAMA_HOST = DEFAULT_OMNIA_ENDPOINT;
export const DEFAULT_OLLAMA_MODEL = "qwen3.8:latest";

export const models: Array<{ id: string; label: string }> = [
  { id: "qwen3.8:latest", label: "Qwen 3.8 (Latest, 27.3B, thinking, tools)" },
  { id: "deepseek-r1:14b", label: "DeepSeek R1 14B (Thinking / Reasoning)" },
  { id: "qwen3.5:9b", label: "Qwen 3.5 9B (Tools + Thinking)" },
  { id: "orcarouter/Qwen3.8-27B-Uncensored:latest", label: "Qwen 3.8 27B Uncensored (Latest)" },
  { id: "orcarouter/Qwen3.8-27B-Uncensored:iq3_m", label: "Qwen 3.8 27B Uncensored (IQ3_M)" },
  { id: "qwen3-vl:latest", label: "Qwen 3 VL (Vision-Language, 8.8B)" },
  { id: "gpt-oss:20b", label: "GPT OSS 20B (MXFP4, thinking, tools)" },
  { id: "qwen3-embedding:0.6b", label: "Qwen 3 Embedding 0.6B" },
];

export interface OllamaModelOptions {
  // Sampling parameters (matching Open WebUI)
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  num_ctx?: number;
  num_predict?: number;
  repeat_penalty?: number;
  repeat_last_n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  mirostat?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  seed?: number;
  stop?: string[];
  num_thread?: number;
  num_gpu?: number;
  tfs_z?: number;
  typical_p?: number;
}

export interface OllamaAdapterConfig extends OllamaModelOptions {
  baseUrl?: string;
  host?: string;
  model?: string;
  system?: string;
  instructionsFilePath?: string;
  keep_alive?: string;
  promptTemplate?: string;
  cwd?: string;
  timeoutSec?: number;
  graceSec?: number;
  env?: Record<string, string>;

  // OmnIA Tool Suite configuration & permissions
  omnia_mode?: "permissive" | "read_only" | "restricted" | "disabled";
  omnia_allowed_domains?: string;
  omnia_allowed_methods?: string;
  omnia_allow_private_networks?: boolean;
  omnia_auth_token?: string;
  omnia_timeout_sec?: number;
  omnia_max_response_bytes?: number;

  // Legacy compatibility fields
  enable_ip_tool?: boolean;
  enable_custom_api_tools?: boolean;
  openapi_spec_url?: string;
  openapi_spec_file?: string;
  graphql_endpoint_url?: string;
}

export const DEFAULT_OLLAMA_OPTIONS: Required<OllamaModelOptions> = {
  temperature: 0.8,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
  num_ctx: 4096,
  num_predict: 2048,
  repeat_penalty: 1.1,
  repeat_last_n: 64,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  mirostat: 0,
  mirostat_tau: 5.0,
  mirostat_eta: 0.1,
  seed: 0,
  stop: [],
  num_thread: 0,
  num_gpu: -1,
  tfs_z: 1.0,
  typical_p: 1.0,
};

export type OmniaModelOptions = OllamaModelOptions;
export type OmniaAdapterConfig = OllamaAdapterConfig;
export const DEFAULT_OMNIA_OPTIONS = DEFAULT_OLLAMA_OPTIONS;

export const agentConfigurationDoc = `# omnia agent configuration

Adapter: omnia

Use when:
- You want Paperclip to run sovereign models through OmnIA (Netvolution AI platform or Ollama-compatible endpoint) (e.g. qwen3.8, deepseek-r1, qwen3.5)
- You want the built-in OmnIA Tool Suite (GitLab REST intelligence, Git changelog, IP lookup, REST/GraphQL API inspection, OSV vulnerability scanner)
- You want granular Open WebUI-style control over model parameters (temperature, num_ctx, top_p, top_k, repeat_penalty, mirostat, etc.)
- You want real-time streaming tokens and function call inspection in task run logs

Don't use when:
- The target OmnIA / Ollama endpoint is not reachable
- You require proprietary closed APIs (Claude, OpenAI) without an OmnIA proxy

Core fields:
- baseUrl (string, optional, default "https://api.ntv.cloud2local.com/omnia/api"): OmnIA / Ollama API endpoint URL
- model (string, required, default "qwen3.8:latest"): Installed model tag
- omnia_tools (string, optional): YAML/JSON OmnIA Tool Registry configuring enabled tools, custom endpoints, and auth
- omnia_mode (string, optional, default "permissive"): Security mode ("permissive", "read_only", "disabled")
- system (string, optional): System instructions prompt override
- instructionsFilePath (string, optional): Path to AGENTS.md markdown instructions file
- promptTemplate (string, optional): Task prompt template
- keep_alive (string, optional, default "15m"): VRAM duration ("5m", "15m", "1h", "-1" to never unload, "0" to unload immediately)

Model Parameters (Open WebUI compliant):
- temperature (number, 0.0 - 2.0, default 0.8): Controls randomness. Lower is deterministic, higher is creative.
- num_ctx (number, default 16384): Context window size in tokens (e.g. 2048, 4096, 8192, 16384, 32768, 131072).
- num_predict (number, default 2048): Maximum tokens to generate in response (-1 for unlimited).
- top_p (number, 0.0 - 1.0, default 0.9): Nucleus sampling threshold.
- top_k (number, 1 - 100, default 40): Restricts sampling pool to top K probable tokens.
- min_p (number, 0.0 - 1.0, default 0.05): Minimum probability relative to most probable token.
- repeat_penalty (number, 0.0 - 2.0, default 1.1): Penalizes token repetition.
- repeat_last_n (number, 0 - 512, default 64): Lookback distance for repetition penalty (0 = disabled).
- presence_penalty (number, -2.0 - 2.0, default 0.0): Penalizes tokens if already present.
- frequency_penalty (number, -2.0 - 2.0, default 0.0): Penalizes tokens proportionally to frequency.
- mirostat (number, default 0): 0 = Disabled, 1 = Mirostat 1.0, 2 = Mirostat 2.0.
- mirostat_tau (number, default 5.0): Mirostat target entropy.
- mirostat_eta (number, default 0.1): Mirostat learning rate.
- seed (number, optional): Fixed random seed for deterministic generation.
- stop (string[], optional): Stop sequences that halt generation.
- num_thread (number, optional): CPU threads allocated for computation.
- num_gpu (number, optional): Number of layers offloaded to GPU (-1 for auto).
- enable_ip_tool (boolean, optional, default true): Expose get_ip_location tool to models supporting function calling.
- enable_custom_api_tools (boolean, optional, default true): Expose call_api_endpoint, query_graphql, and inspect_api_documentation tools.
- openapi_spec_url (string, optional): URL or file path to OpenAPI 3.x / Swagger specification for REST documentation discovery.
- graphql_endpoint_url (string, optional): GraphQL endpoint URL for automatic query execution and schema introspection.
`;

export { createServerAdapter } from "./server/index.js";
export {
  getIpLocation,
  getPublicIp,
  IP_LOCATION_TOOL_DEFINITION,
  type IpLocationData,
} from "./server/tools/ip-location.js";
export {
  resolveAuth,
  type AuthConfig,
  type ResolvedAuth,
} from "./server/tools/auth.js";
export {
  loadOpenApiSpec,
  formatOpenApiDocs,
  executeRestEndpoint,
  type ParsedOpenApiSpec,
  type OpenApiOperation,
  type EndpointExecutionResult,
} from "./server/tools/openapi.js";
export {
  executeGraphQL,
  introspectGraphQLSchema,
  formatGraphQLDocs,
  type GraphQLExecutionResult,
  type ParsedGraphQLSchema,
} from "./server/tools/graphql.js";
export {
  CALL_API_ENDPOINT_TOOL_DEFINITION,
  QUERY_GRAPHQL_TOOL_DEFINITION,
  INSPECT_API_DOCS_TOOL_DEFINITION,
  GENERIC_API_TOOLS,
  handleCallApiEndpoint,
  handleQueryGraphQL,
  handleInspectApiDocs,
} from "./server/tools/custom-endpoint.js";
export {
  OMNIA_TOOL_DEFINITION,
  OMNIA_TOOLS,
  OMNIA_IP_TOOL_DEFINITION,
  OMNIA_HTTP_TOOL_DEFINITION,
  OMNIA_GRAPHQL_TOOL_DEFINITION,
  OMNIA_INSPECT_TOOL_DEFINITION,
  executeOmniaOperation,
  parseOmniaPermissions,
  isDomainAllowed,
  isMethodAllowed,
  type OmniaOperation,
  type OmniaPermissionMode,
  type OmniaPermissions,
  type OmniaCallArguments,
  type OmniaExecutionResult,
} from "./server/tools/omnia.js";
export {
  DEFAULT_OMNIA_TOOLS,
  parseConfiguredTools,
  getEnabledTools,
  type OmniaToolDefinition,
  type ToolType,
} from "./server/tools/tool-registry.js";
export {
  GIT_INTELLIGENCE_TOOL_DEFINITION,
  executeGitIntelligence,
  type GitToolResult,
} from "./server/tools/git-intelligence.js";
export {
  OMNIA_LOGO_DARK_SVG,
  OMNIA_LOGO_LIGHT_SVG,
  OMNIA_LOGO_DARK_DATA_URI,
  OMNIA_LOGO_LIGHT_DATA_URI,
} from "./server/tools/omnia-icons.js";
