import type { AdapterModel } from "../types.js";
import { asString } from "./utils.js";
import { DEFAULT_OLLAMA_HOST, models as fallbackModels } from "../index.js";

const MODELS_CACHE_TTL_MS = 60_000;

interface OllamaTagEntry {
  name: string;
  model: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
  };
  capabilities?: string[];
}

interface OllamaTagsResponse {
  models?: OllamaTagEntry[];
}

let cachedModels: { expiresAt: number; models: AdapterModel[] } | null = null;
let lastKnownHost: string | null = null;

export function recordActiveOllamaHost(host: string, models?: AdapterModel[]): void {
  if (host && typeof host === "string") {
    const cleaned = host.trim().replace(/\/$/, "");
    if (cleaned.length > 0) {
      lastKnownHost = cleaned;
      if (models && models.length > 0) {
        cachedModels = {
          expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
          models,
        };
      }
    }
  }
}

export function getLastKnownOllamaHost(): string | null {
  return lastKnownHost;
}

function resolveOllamaHost(customHost?: string): string {
  const envHost = process.env.PAPERCLIP_OLLAMA_HOST || process.env.OLLAMA_HOST;
  const target = asString(customHost || envHost || lastKnownHost, DEFAULT_OLLAMA_HOST).trim();
  return target.replace(/\/$/, "");
}

export async function fetchOllamaTags(host: string): Promise<AdapterModel[]> {
  const url = `${host}/api/tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as OllamaTagsResponse;
    if (!data.models || !Array.isArray(data.models) || data.models.length === 0) {
      return [];
    }

    const parsed = data.models.map((m) => {
      const parts: string[] = [];
      if (m.details?.parameter_size) parts.push(m.details.parameter_size);
      if (m.details?.quantization_level) parts.push(m.details.quantization_level);
      if (m.capabilities?.includes("thinking")) parts.push("thinking");
      if (m.capabilities?.includes("tools")) parts.push("tools");

      const extra = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return {
        id: m.name,
        label: `${m.name}${extra}`,
      };
    });

    if (parsed.length > 0) {
      recordActiveOllamaHost(host, parsed);
    }
    return parsed;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedModelResult {
  model: string;
  autoSelected: boolean;
  availableModels: string[];
  warning?: string;
}

export async function resolveModelForHost(
  configuredModel: string | undefined,
  host: string,
): Promise<ResolvedModelResult> {
  const requested = (configuredModel || "").trim();
  const tags = await fetchOllamaTags(host);
  const availableNames = tags.map((t) => t.id);

  if (tags.length === 0) {
    // Host unreachable or no models installed yet
    return {
      model: requested || "qwen2.5:7b",
      autoSelected: false,
      availableModels: [],
    };
  }

  // Record active host
  recordActiveOllamaHost(host, tags);

  // If user didn't specify a model, or specified obsolete default placeholder "qwen3:8b" not installed on remote
  const isPlaceholderDefault = !requested || (requested === "qwen3:8b" && !availableNames.includes("qwen3:8b"));
  if (isPlaceholderDefault) {
    // Prefer a model that has tools or thinking support, or common modern models
    const toolCandidate = tags.find((m) =>
      m.label.toLowerCase().includes("tools") ||
      m.id.toLowerCase().includes("qwen") ||
      m.id.toLowerCase().includes("llama"),
    );
    const chosen = toolCandidate ? toolCandidate.id : tags[0].id;
    const warning = `[omnia] Configured model "${requested || "(none)"}" is not installed on remote host ${host}. Auto-selected available model "${chosen}" (Installed on remote: ${availableNames.join(", ")}).`;
    return {
      model: chosen,
      autoSelected: true,
      availableModels: availableNames,
      warning,
    };
  }

  // Exact match
  if (availableNames.includes(requested)) {
    return {
      model: requested,
      autoSelected: false,
      availableModels: availableNames,
    };
  }

  // Prefix or tag match (e.g. user entered "llama3.1" and host has "llama3.1:latest" or "llama3.1:8b")
  const prefixMatch = tags.find(
    (t) => t.id === `${requested}:latest` || t.id.startsWith(`${requested}:`),
  );
  if (prefixMatch) {
    return {
      model: prefixMatch.id,
      autoSelected: false,
      availableModels: availableNames,
      warning: `[omnia] Model "${requested}" resolved to remote tag "${prefixMatch.id}".`,
    };
  }

  // Model specified by user but not found on host
  return {
    model: requested,
    autoSelected: false,
    availableModels: availableNames,
    warning: `[omnia] Warning: Model "${requested}" was not found in tags on host ${host}. Available models: [${availableNames.join(", ")}].`,
  };
}

export async function listOllamaModels(customHost?: string): Promise<AdapterModel[]> {
  const host = resolveOllamaHost(customHost);
  const now = Date.now();

  if (cachedModels && cachedModels.expiresAt > now) {
    return cachedModels.models;
  }

  const fetched = await fetchOllamaTags(host);
  if (fetched.length > 0) {
    cachedModels = {
      expiresAt: now + MODELS_CACHE_TTL_MS,
      models: fetched,
    };
    return fetched;
  }

  return fallbackModels;
}

export async function refreshOllamaModels(customHost?: string): Promise<AdapterModel[]> {
  const host = resolveOllamaHost(customHost);
  cachedModels = null;
  const fetched = await fetchOllamaTags(host);
  if (fetched.length > 0) {
    cachedModels = {
      expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
      models: fetched,
    };
    return fetched;
  }
  return fallbackModels;
}
