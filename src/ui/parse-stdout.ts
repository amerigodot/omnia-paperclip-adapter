import type { TranscriptEntry } from "../types.js";

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line || !line.trim()) return [];
  if (line.startsWith("[omnia]") || line.startsWith("[ollama_local]")) {
    return [{ kind: "system", ts, text: line }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
