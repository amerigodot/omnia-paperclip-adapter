import type { CreateConfigValues } from "../types.js";

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {
    ...(v.adapterSchemaValues ?? {}),
  };

  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.timeoutSec !== undefined) ac.timeoutSec = v.timeoutSec;

  if (v.envVars) {
    try {
      ac.env = typeof v.envVars === "string" ? JSON.parse(v.envVars) : v.envVars;
    } catch {
      // ignore
    }
  }

  return ac;
}
