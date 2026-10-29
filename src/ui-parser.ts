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

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line || !line.trim()) return [];
  const trimmed = line.trim();

  if (trimmed.startsWith("[omnia:tool_call]") || trimmed.startsWith("[ollama_local:tool_call]")) {
    const raw = trimmed
      .replace("[omnia:tool_call]", "")
      .replace("[ollama_local:tool_call]", "")
      .trim();
    try {
      const parsed = JSON.parse(raw);
      return [
        {
          kind: "tool_call",
          ts,
          name: parsed.name || "omnia",
          input: parsed.arguments,
          toolUseId: parsed.id || parsed.name || "call-1",
        },
      ];
    } catch {
      return [{ kind: "tool_call", ts, name: "omnia", text: raw }];
    }
  }

  if (trimmed.startsWith("[omnia:tool_result]") || trimmed.startsWith("[ollama_local:tool_result]")) {
    const raw = trimmed
      .replace("[omnia:tool_result]", "")
      .replace("[ollama_local:tool_result]", "")
      .trim();
    return [
      {
        kind: "tool_result",
        ts,
        content: raw,
      },
    ];
  }

  if (trimmed.startsWith("[omnia]") || trimmed.startsWith("[ollama_local]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  if (trimmed.startsWith("Error:") || trimmed.startsWith("[error]")) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  return [{ kind: "assistant", ts, text: line }];
}
