export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function resolvePathValue(data: Record<string, unknown>, path: string): string {
  const parts = path.split(".");
  let curr: unknown = data;
  for (const part of parts) {
    if (curr === null || typeof curr !== "object") return "";
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr !== undefined && curr !== null ? String(curr) : "";
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path: string) =>
    resolvePathValue(data, path),
  );
}

export const DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE = `Task: {{context.task}}
Wake reason: {{context.wakeReason}}
`;

/**
 * Compacts and safely trims tool output payloads to prevent context window exhaustion
 * and chat template crashes (e.g. Qwen "no user query found in messages" caused by context pruning).
 */
export function compactToolResponse(input: unknown, maxChars = 10000): unknown {
  if (input === null || input === undefined) return input;

  function pruneValue(val: unknown, depth = 0): unknown {
    if (val === null || val === undefined) return val;
    if (depth > 6) return "[Max depth reached]";

    if (typeof val === "string") {
      if (val.length > 800) {
        return val.slice(0, 800) + "... [truncated]";
      }
      return val;
    }

    if (typeof val !== "object") return val;

    if (Array.isArray(val)) {
      // Limit arrays (e.g. commits, releases) to first 5 items
      const slice = (val as unknown[]).slice(0, 5);
      const res = slice.map((item) => pruneValue(item, depth + 1));
      if (val.length > 5) {
        (res as any).push(`... [${val.length - 5} more items omitted to fit context]`);
      }
      return res;
    }

    // Object
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      // Strip noisy GitHub / REST boilerplate
      if (
        (k.endsWith("_url") && k !== "html_url" && k !== "url") ||
        k === "node_id" ||
        k === "gravatar_id" ||
        k === "avatar_url" ||
        k === "tarball_url" ||
        k === "zipball_url"
      ) {
        continue;
      }
      cleaned[k] = pruneValue(v, depth + 1);
    }
    return cleaned;
  }

  let result = pruneValue(input);
  let serialized = JSON.stringify(result);

  // If still too large, aggressively reduce data payload
  if (serialized.length > maxChars) {
    if (typeof result === "object" && result !== null && "data" in (result as any)) {
      const copy = { ...(result as any) };
      if (Array.isArray(copy.data)) {
        copy.data = copy.data.slice(0, 2);
      } else if (typeof copy.data === "object" && copy.data !== null) {
        const smallData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(copy.data as Record<string, unknown>).slice(0, 15)) {
          smallData[k] = v;
        }
        copy.data = smallData;
      }
      result = copy;
      serialized = JSON.stringify(result);
    }
  }

  // Hard guarantee: if stringified length is still > maxChars, slice string
  if (serialized.length > maxChars) {
    return {
      status: (input as any)?.status ?? "success",
      notice: `Payload was truncated to ${maxChars} chars to preserve LLM context.`,
      preview: serialized.slice(0, maxChars - 100) + "...",
    };
  }

  return result;
}
