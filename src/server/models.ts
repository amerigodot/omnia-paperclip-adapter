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

function resolveOllamaHost(customHost?: string): string {
  const envHost = process.env.OLLAMA_HOST || process.env.PAPERCLIP_OLLAMA_HOST;
  const target = asString(customHost || envHost, DEFAULT_OLLAMA_HOST).trim();
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

    return data.models.map((m) => {
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
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
