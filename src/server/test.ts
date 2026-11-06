import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, resolveOllamaUrl } from "./utils.js";
import { DEFAULT_OLLAMA_HOST, type } from "../index.js";
import { fetchOllamaTags, recordActiveOllamaHost } from "./models.js";

function resolveHost(config: Record<string, unknown>): string {
  const custom = asString(config.baseUrl || config.host || process.env.OMNIA_HOST || process.env.OLLAMA_HOST, DEFAULT_OLLAMA_HOST).trim();
  return custom.replace(/\/$/, "");
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const host = resolveHost(ctx.config);
  const testedAt = new Date().toISOString();

  try {
    const models = await fetchOllamaTags(host);
    if (models.length > 0) {
      recordActiveOllamaHost(host, models);
      const modelNames = models.map((m) => m.id);

      let version = "remote";
      try {
        const vUrl = resolveOllamaUrl(host, "/api/version");
        const vRes = await fetch(vUrl, { signal: AbortSignal.timeout(2000) });
        if (vRes.ok) {
          const vData = (await vRes.json()) as { version?: string };
          if (vData.version) version = vData.version;
        }
      } catch {
        // version is optional
      }

      return {
        adapterType: type,
        status: "pass",
        testedAt,
        checks: [
          {
            code: "omnia_connected",
            level: "info",
            message: `Connected to OmnIA daemon (${version}) at ${host}. ${models.length} model(s) available (${modelNames.slice(0, 5).join(", ")}${modelNames.length > 5 ? ", ..." : ""}).`,
          },
        ],
      };
    }

    // Secondary probe: try version endpoint directly if no models returned
    const vUrl = resolveOllamaUrl(host, "/api/version");
    const versionRes = await fetch(vUrl, { signal: AbortSignal.timeout(3000) });
    if (versionRes.ok) {
      return {
        adapterType: type,
        status: "pass",
        testedAt,
        checks: [
          {
            code: "omnia_connected",
            level: "info",
            message: `Connected to OmnIA daemon at ${host} (no models installed).`,
          },
        ],
      };
    }

    return {
      adapterType: type,
      status: "fail",
      testedAt,
      checks: [
        {
          code: "omnia_http_error",
          level: "error",
          message: `OmnIA endpoint at ${host} is unreachable or returned no models from /tags.`,
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
          code: "omnia_unreachable",
          level: "error",
          message: `Failed to connect to OmnIA daemon at ${host} (${message}).`,
        },
      ],
    };
  }
}
