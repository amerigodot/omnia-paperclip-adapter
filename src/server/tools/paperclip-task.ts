export const SET_TASK_TITLE_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "set_task_title",
    description: "Sets or updates the task title in Paperclip when requested or when provisional.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Concise title describing the requested outcome",
        },
        onlyIfProvisional: {
          type: "boolean",
          description: "Only set if the current task title is provisional",
        },
      },
      required: ["title"],
    },
  },
};

export async function handleSetTaskTitle(
  args: Record<string, unknown>,
  opts: {
    issueId?: string | null;
    apiUrl?: string;
    authToken?: string;
  },
): Promise<{ success: boolean; title?: string; changed?: boolean; error?: string }> {
  const issueId = opts.issueId?.trim();
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const onlyIfProvisional = args.onlyIfProvisional !== false;

  if (!title) {
    return { success: false, error: "Title must not be empty" };
  }

  if (!issueId) {
    // If not bound to an issue, acknowledge cleanly
    return { success: true, title, changed: false };
  }

  const apiUrl = (opts.apiUrl || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.authToken) {
    headers.Authorization = `Bearer ${opts.authToken}`;
  }

  try {
    const res = await fetch(`${apiUrl}/api/issues/${issueId}/title`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        title,
        onlyIfProvisional,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${errText}` };
    }

    const data = (await res.json().catch(() => ({}))) as { changed?: boolean; title?: string };
    const savedTitle = data.title || title;
    return {
      success: true,
      title: savedTitle,
      changed: data.changed ?? true,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Transitions a Paperclip issue status to 'done'.
 * This prevents Paperclip's watchdog from escalating disposition_repair retries.
 */
export async function markIssueDone(opts: {
  issueId?: string | null;
  apiUrl?: string;
  authToken?: string;
}): Promise<boolean> {
  const issueId = opts.issueId?.trim();
  if (!issueId) return false;

  const apiUrl = (opts.apiUrl || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.authToken) {
    headers.Authorization = `Bearer ${opts.authToken}`;
  }

  try {
    const res = await fetch(`${apiUrl}/api/issues/${issueId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        status: "done",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
