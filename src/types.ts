export interface AdapterModel {
  id: string;
  label: string;
}

export interface AdapterEnvironmentCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  hint?: string;
}

export interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: "pass" | "warn" | "fail";
  testedAt: string;
  checks: AdapterEnvironmentCheck[];
}

export interface AdapterAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType?: string | null;
  adapterConfig: Record<string, unknown>;
}

export interface AdapterRuntime {
  sessionId: string | null;
  sessionDisplayId?: string | null;
  sessionParams: Record<string, unknown> | null;
  taskKey?: string | null;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onDispatch?: () => void;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  summary?: string | null;
  reportedWorkDisposition?: "done" | "yielded" | "completed" | string | null;
}

export interface ConfigFieldOption {
  value: string;
  label: string;
}

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "boolean";
  default?: unknown;
  hint?: string;
  options?: ConfigFieldOption[];
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export interface ServerAdapterModule {
  type: string;
  label?: string;
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  testEnvironment: (ctx: AdapterEnvironmentTestContext) => Promise<AdapterEnvironmentTestResult>;
  getConfigSchema?: () => AdapterConfigSchema | Promise<AdapterConfigSchema>;
  listModels?: () => Promise<AdapterModel[]>;
  refreshModels?: () => Promise<AdapterModel[]>;
  supportsLocalAgentJwt?: boolean;
  supportsInstructionsBundle?: boolean;
  instructionsPathKey?: string;
  agentConfigurationDoc?: string;
  models?: AdapterModel[];
}

export interface TranscriptEntry {
  kind: "assistant" | "thinking" | "user" | "tool_call" | "tool_result" | "system" | "stderr" | "stdout";
  ts: string;
  text?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  delta?: boolean;
}

export type CreateConfigValues = Record<string, unknown>;
