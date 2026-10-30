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
export function compactToolResponse(data: unknown, maxChars = 15000): unknown {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    if (data.length <= maxChars) return data;
    return data.slice(0, maxChars) + `\n\n...[Truncated: output was ${data.length} characters, truncated to ${maxChars} to fit model context]`;
  }

  if (typeof data === "object") {
    if (Array.isArray(data)) {
      // If array of items (e.g. releases, commits, tags), keep up to 10 items
      const trimmedArray = (data as unknown[]).slice(0, 10).map((item) => {
        if (typeof item === "object" && item !== null) {
          const itemCleaned: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            // Strip verbose boilerplate *_url templates like /issues{/number}
            if (k.endsWith("_url") && typeof v === "string" && v.includes("{")) continue;
            itemCleaned[k] = v;
          }
          return itemCleaned;
        }
        return item;
      });

      const str = JSON.stringify(trimmedArray);
      if (str.length <= maxChars) return trimmedArray;

      // Progressively reduce items if still too large
      for (let count = 5; count >= 1; count--) {
        const smaller = trimmedArray.slice(0, count);
        const smallerStr = JSON.stringify(smaller);
        if (smallerStr.length <= maxChars) return smaller;
      }
      return [
        {
          _notice: `Array of ${data.length} items was truncated to prevent context overflow.`,
          sample: trimmedArray[0],
        },
      ];
    }

    // It is an object (e.g. repository details or API result)
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      // Strip verbose boilerplate *_url templates
      if (k.endsWith("_url") && typeof v === "string" && v.includes("{")) continue;
      cleaned[k] = v;
    }

    const str = JSON.stringify(cleaned);
    if (str.length <= maxChars) return cleaned;

    // Truncate long string fields (e.g. description, body, readme, patch diffs)
    for (const [k, v] of Object.entries(cleaned)) {
      if (typeof v === "string" && v.length > 1000) {
        cleaned[k] = v.slice(0, 1000) + "... [truncated]";
      }
    }

    const reStr = JSON.stringify(cleaned);
    if (reStr.length <= maxChars) return cleaned;

    return {
      ...cleaned,
      _truncated: true,
      _notice: `Response truncated to ${maxChars} characters to fit model context.`,
    };
  }

  return data;
}
