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
