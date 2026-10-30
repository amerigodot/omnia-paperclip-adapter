import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString } from "./utils.js";
import { DEFAULT_OLLAMA_HOST, type } from "../index.js";
import { fetchOllamaTags, recordActiveOllamaHost } from "./models.js";

function resolveHost(config: Record<string, unknown>): string {
  const custom = asString(config.baseUrl || config.host || process.env.OLLAMA_HOST, DEFAULT_OLLAMA_HOST).trim();
  return custom.replace(/\/$/, "");
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const host = resolveHost(ctx.config);
  const testedAt = new Date().toISOString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const versionRes = await fetch(`${host}/api/version`, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!versionRes.ok) {
      return {
        adapterType: type,
        status: "fail",
        testedAt,
        checks: [
          {
            code: "ollama_http_error",
            level: "error",
            message: `Ollama at ${host} returned HTTP ${versionRes.status}: ${versionRes.statusText}`,
          },
        ],
      };
    }

    const versionData = (await versionRes.json()) as { version?: string };
    const version = versionData.version || "unknown";

    const models = await fetchOllamaTags(host);
    recordActiveOllamaHost(host, models);
    const modelNames = models.map((m) => m.id);

    return {
      adapterType: type,
      status: "pass",
      testedAt,
      checks: [
        {
          code: "ollama_connected",
          level: "info",
          message: `Connected to Ollama daemon v${version} at ${host}. ${models.length} model(s) installed (${modelNames.slice(0, 5).join(", ")}${modelNames.length > 5 ? ", ..." : ""}).`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      adapterType: type,
      status: "fail",
      testedAt,
      checks: [
        {
          code: "ollama_unreachable",
          level: "error",
          message: `Cannot reach Ollama daemon at ${host} (${message}). Verify that Ollama is running ('ollama serve') and accessible.`,
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}
