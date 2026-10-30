import fs from "node:fs/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../types.js";
import {
  asNumber,
  asString,
  asStringArray,
  renderTemplate,
  compactToolResponse,
  prunePriorToolMessages,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "./utils.js";
import { DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL } from "../index.js";
import {
  recordActiveOllamaHost,
  resolveModelForHost,
  fetchOllamaTags,
} from "./models.js";
import {
  getIpLocation,
  IP_LOCATION_TOOL_DEFINITION,
} from "./tools/ip-location.js";
import {
  GENERIC_API_TOOLS,
  handleCallApiEndpoint,
  handleQueryGraphQL,
  handleInspectApiDocs,
} from "./tools/custom-endpoint.js";
import {
  OMNIA_TOOLS,
  executeOmniaOperation,
  parseOmniaPermissions,
} from "./tools/omnia.js";
import {
  parseConfiguredTools,
  getEnabledTools,
  buildOllamaTools,
  executeToolByName,
  type OmniaToolDefinition,
} from "./tools/tool-registry.js";
import { loadOpenApiSpec, formatOpenApiDocs } from "./tools/openapi.js";
import {
  handleSetTaskTitle,
  SET_TASK_TITLE_TOOL_DEFINITION,
  SAVE_ARTIFACT_TOOL_DEFINITION,
  handleSaveArtifact,
  deriveTitleFromMarkdown,
  isStructuredMarkdownReport,
  extractReportMarkdown,
  normalizeArtifactKey,
  markIssueDone,
} from "./tools/paperclip-task.js";

interface ToolCall {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface OllamaStreamChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

function resolveHost(config: Record<string, unknown>): string {
  const custom = asString(config.baseUrl || config.host || process.env.OLLAMA_HOST, DEFAULT_OLLAMA_HOST).trim();
  return custom.replace(/\/$/, "");
}

function resolveModel(config: Record<string, unknown>): string {
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim();
  return model.length > 0 ? model : DEFAULT_OLLAMA_MODEL;
}

function buildOllamaOptions(config: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  if (config.temperature !== undefined && config.temperature !== "") {
    options.temperature = asNumber(config.temperature, 0.8);
  }
  if (config.top_p !== undefined && config.top_p !== "") {
    options.top_p = asNumber(config.top_p, 0.9);
  }
  if (config.top_k !== undefined && config.top_k !== "") {
    options.top_k = asNumber(config.top_k, 40);
  }
  if (config.min_p !== undefined && config.min_p !== "") {
    options.min_p = asNumber(config.min_p, 0.05);
  }
  options.num_ctx = config.num_ctx !== undefined && config.num_ctx !== ""
    ? asNumber(config.num_ctx, 16384)
    : 16384;
  if (config.num_predict !== undefined && config.num_predict !== "") {
    options.num_predict = asNumber(config.num_predict, 2048);
  }
  if (config.repeat_penalty !== undefined && config.repeat_penalty !== "") {
    options.repeat_penalty = asNumber(config.repeat_penalty, 1.1);
  }
  if (config.repeat_last_n !== undefined && config.repeat_last_n !== "") {
    options.repeat_last_n = asNumber(config.repeat_last_n, 64);
  }
  if (config.presence_penalty !== undefined && config.presence_penalty !== "") {
    options.presence_penalty = asNumber(config.presence_penalty, 0.0);
  }
  if (config.frequency_penalty !== undefined && config.frequency_penalty !== "") {
    options.frequency_penalty = asNumber(config.frequency_penalty, 0.0);
  }
  if (config.mirostat !== undefined && config.mirostat !== "") {
    options.mirostat = asNumber(config.mirostat, 0);
  }
  if (config.mirostat_tau !== undefined && config.mirostat_tau !== "") {
    options.mirostat_tau = asNumber(config.mirostat_tau, 5.0);
  }
  if (config.mirostat_eta !== undefined && config.mirostat_eta !== "") {
    options.mirostat_eta = asNumber(config.mirostat_eta, 0.1);
  }
  if (config.seed !== undefined && config.seed !== null && config.seed !== "") {
    options.seed = asNumber(config.seed, 0);
  }
  if (config.stop !== undefined && config.stop !== null) {
    if (Array.isArray(config.stop)) {
      options.stop = asStringArray(config.stop);
    } else if (typeof config.stop === "string" && config.stop.trim().length > 0) {
      options.stop = config.stop.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (config.num_thread !== undefined && config.num_thread !== "") {
    const thread = asNumber(config.num_thread, 0);
    if (thread > 0) options.num_thread = thread;
  }
  if (config.num_gpu !== undefined && config.num_gpu !== "") {
    options.num_gpu = asNumber(config.num_gpu, -1);
  }

  return options;
}

function cleanRawPaperclipTaskMarkdown(raw: string): string {
  let cleaned = raw;
  cleaned = cleaned.replace(/Paperclip task context:[\s\S]*?do not treat it as permission[^\n]*\n+/i, "");
  cleaned = cleaned.replace(/Task question guidance:[\s\S]*?without repeating their reminders\.\n+/i, "");
  cleaned = cleaned.replace(/Task clarification directive:[\s\S]*?without asking for the same information again\.\n+/i, "");
  cleaned = cleaned.replace(/Task title directive:[\s\S]*?if retrying with changed arguments\.\n+/i, "");
  cleaned = cleaned.replace(/External chat file delivery:[\s\S]*?(never claim it was sent\.|never repeat a successful upload merely to confirm it\.)\n+/i, "");
  cleaned = cleaned.replace(/Follow-up directive:[\s\S]*?Reuse completed work rather than repeating it\.\n+/i, "");
  cleaned = cleaned.replace(/Use this task context as the current assignment\.\s*$/i, "");
  return cleaned.trim() || raw.trim();
}

function buildCleanUserPrompt(context: Record<string, unknown>, rawTaskFallback: string): string {
  const issue =
    typeof context.paperclipIssue === "object" && context.paperclipIssue !== null
      ? (context.paperclipIssue as Record<string, unknown>)
      : null;

  const wakeComment =
    typeof context.paperclipWakeComment === "object" && context.paperclipWakeComment !== null
      ? asString((context.paperclipWakeComment as Record<string, unknown>).body, "").trim()
      : "";

  const wakeComments = Array.isArray(context.wakeComments) ? context.wakeComments : [];
  const latestWake =
    wakeComment ||
    (wakeComments.length > 0
      ? asString((wakeComments[wakeComments.length - 1] as Record<string, unknown>)?.body, "").trim()
      : "");

  if (issue) {
    const identifier = asString(issue.identifier, "").trim();
    const title = asString(issue.title, "").trim();
    const description = asString(issue.description, "").trim();

    const parts: string[] = [];
    if (identifier && title && identifier !== title) {
      parts.push(`Task: [${identifier}] ${title}`);
    } else if (identifier) {
      parts.push(`Task: ${identifier}`);
    } else if (title) {
      parts.push(`Task: ${title}`);
    }

    if (description) {
      parts.push(`Description:\n${description}`);
    }

    if (latestWake && latestWake !== description) {
      parts.push(`Latest user message:\n${latestWake}`);
    }

    if (parts.length > 0) {
      return parts.join("\n\n");
    }
  }

  if (rawTaskFallback) {
    return cleanRawPaperclipTaskMarkdown(rawTaskFallback);
  }

  const wakeReason = asString(context.wakeReason, "").trim();
  return wakeReason
    ? `Wake reason: ${wakeReason}. Check in and proceed with your current objectives.`
    : "Check in and proceed with your current objectives.";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, agent, runtime, onLog, onDispatch } = ctx;

  // Merge agent adapterConfig, context overrides, and runtime config to guarantee that
  // any security mode or parameter configured via UI or API is 100% authoritative.
  const effectiveConfig: Record<string, unknown> = {
    ...(agent?.adapterConfig as Record<string, unknown> || {}),
    ...(context?.adapterConfig as Record<string, unknown> || {}),
    ...config,
  };

  // Populate environment variables from agent configuration into process.env for tool auth resolution
  if (effectiveConfig.env && typeof effectiveConfig.env === "object") {
    for (const [k, v] of Object.entries(effectiveConfig.env as Record<string, unknown>)) {
      if (typeof v === "string") {
        process.env[k] = v;
      } else if (v && typeof v === "object" && "value" in v && typeof (v as any).value === "string") {
        process.env[k] = (v as any).value;
      }
    }
  }

  const host = resolveHost(effectiveConfig);
  recordActiveOllamaHost(host);

  const modelResolution = await resolveModelForHost(
    asString(effectiveConfig.model, ""),
    host,
  );
  const model = modelResolution.model;
  if (modelResolution.warning) {
    await onLog("stdout", `${modelResolution.warning}\n`);
  }
  const options = buildOllamaOptions(effectiveConfig);
  const keepAlive = asString(effectiveConfig.keep_alive, "15m").trim();
  const timeoutSec = asNumber(effectiveConfig.timeoutSec, 0);

  const issueId = asString(
    context.issueId ||
    (typeof context.paperclipIssue === "object" && context.paperclipIssue !== null
      ? (context.paperclipIssue as Record<string, unknown>).id
      : "") ||
    runtime.taskKey,
    "",
  ).trim();
  const apiUrl = asString(process.env.PAPERCLIP_API_URL, "http://127.0.0.1:3100");
  const authToken = asString(ctx.authToken || context.authToken, "");

  // 1. Gather instructions / system prompt
  let systemPrompt = asString(config.system, "").trim();
  const instructionsPath = asString(config.instructionsFilePath, "").trim();
  if (instructionsPath) {
    try {
      const instructionsContent = await fs.readFile(instructionsPath, "utf-8");
      if (instructionsContent.trim()) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n---\n\n${instructionsContent.trim()}`
          : instructionsContent.trim();
      }
    } catch (err) {
      await onLog("stderr", `[omnia] Warning: Could not read instructions file ${instructionsPath}: ${err}\n`);
    }
  }

  // 2. Build clean user prompt from context
  const payloadPrompt = typeof context.payload === "object" && context.payload !== null
    ? asString((context.payload as Record<string, unknown>).prompt, "").trim()
    : "";

  const rawTaskText =
    asString(context.paperclipTaskMarkdown, "").trim() ||
    asString(context.paperclipTaskMarkdownAssignment, "").trim() ||
    asString(context.task, "").trim() ||
    asString(context.prompt, "").trim() ||
    payloadPrompt;

  let promptText = "";
  if (config.promptTemplate) {
    promptText = renderTemplate(asString(config.promptTemplate, ""), {
      agent,
      context,
      task: rawTaskText,
      wakeReason: context.wakeReason ?? "",
    }).trim();
  }

  if (!promptText) {
    promptText = buildCleanUserPrompt(context, rawTaskText);
  }

  // Automatically derive and set provisional task title in Paperclip if needed
  const issueObj = (typeof context.paperclipIssue === "object" && context.paperclipIssue !== null)
    ? (context.paperclipIssue as Record<string, unknown>)
    : null;
  const titleNeedsGeneration = issueObj?.titleNeedsGeneration === true;

  if (issueId && titleNeedsGeneration) {
    const rawContent = asString(issueObj?.description || promptText, "").trim();
    const firstLine = rawContent.split("\n")[0].trim().replace(/^[-*#\s]+/, "");
    const derivedTitle = firstLine.slice(0, 60).trim();
    if (derivedTitle) {
      try {
        await handleSetTaskTitle(
          { title: derivedTitle, onlyIfProvisional: true },
          { issueId, apiUrl, authToken },
        );
        await onLog("stdout", `[omnia] Derived and saved provisional task title: "${derivedTitle}" in Paperclip.\n`);
      } catch (err) {
        await onLog("stderr", `[omnia] Warning: Could not update provisional title: ${err}\n`);
      }
    }
  }

  const omniaPermissions = parseOmniaPermissions(effectiveConfig);
  const configuredTools = parseConfiguredTools(effectiveConfig);
  const enabledTools = getEnabledTools(configuredTools);
  const enabledToolNames = enabledTools.map((t) => t.name);

  if ((configuredTools as any).parseError) {
    await onLog(
      "stderr",
      `[omnia:tools] Warning: Could not parse custom tools from omnia_tools (${(configuredTools as any).parseError}). Default tools loaded.\n`,
    );
  }

  await onLog(
    "stdout",
    `[omnia:tools] Tool Registry: ${configuredTools.length} tool(s) registered (${enabledTools.length} enabled: [${enabledToolNames.join(", ")}])\n`,
  );
  await onLog(
    "stdout",
    `[omnia:security] Active security mode: "${omniaPermissions.mode}" | Allowed domains: [${omniaPermissions.allowedDomains.length > 0 ? omniaPermissions.allowedDomains.join(", ") : "*"}] | Allowed methods: [${omniaPermissions.allowedMethods.join(", ")}] | SSRF guard: ${omniaPermissions.allowPrivateNetworks ? "disabled (private networks allowed)" : "active (private networks blocked)"}\n`,
  );

  let defaultAgentGuidance = "";
  if (enabledTools.length === 0 || omniaPermissions.mode === "disabled") {
    defaultAgentGuidance =
      "OmnIA tool engine is currently DISABLED or no tools are enabled in settings.\n" +
      "- External network operations, IP lookups, REST APIs, and GraphQL tools are unavailable.\n" +
      "- If the user requests external data, IP lookups, or network operations, politely explain that tools are currently disabled in agent settings.";
  } else {
    const toolListSummary = enabledTools
      .map((t) => `- \`${t.name}\`: ${t.description}${t.access?.url ? ` (Target: ${t.access.url})` : ""}`)
      .join("\n");

    defaultAgentGuidance =
      "You are an autonomous AI worker executing tasks in Paperclip with the OmnIA tool engine.\n" +
      "- Your goal is to fulfill the user's request accurately, directly, and thoughtfully.\n" +
      `- You have access to the following ${enabledTools.length} enabled tool(s):\n${toolListSummary}\n` +
      "- When external data or operations are required, invoke the appropriate tool with explicit call parameters.\n" +
      "- Once a tool returns the result, analyze, synthesize, and elaborate the data clearly to formulate a complete, conversational response in the language of the prompt (do not just dump raw JSON).\n" +
      "- When creating comprehensive reports, security audits, or persistent documentation, use the `save_artifact` tool to store the report as a persistent Paperclip artifact/document.";
  }

  systemPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n${defaultAgentGuidance}`
    : defaultAgentGuidance;

  const messages: OllamaChatMessage[] = [];
  messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: promptText });

  // 3. Prepare request payload and tools with OmnIA suite
  const tools: unknown[] = buildOllamaTools(configuredTools);
  if (issueId) {
    tools.push(SAVE_ARTIFACT_TOOL_DEFINITION);
  }

  // Pre-load OpenAPI documentation if configured
  const openApiSpecSource = asString(config.openapi_spec_url || config.openapi_spec_file, "").trim();
  if (openApiSpecSource) {
    try {
      const spec = await loadOpenApiSpec(openApiSpecSource);
      const docsSummary = formatOpenApiDocs(spec);
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n---\n## Pre-configured OpenAPI Documentation\n${docsSummary}`
        : `## Pre-configured OpenAPI Documentation\n${docsSummary}`;
    } catch (err) {
      await onLog("stderr", `[omnia] Warning: Could not pre-load OpenAPI spec from ${openApiSpecSource}: ${err}\n`);
    }
  }

  // Pre-load GraphQL endpoint note if configured
  const graphqlEndpointUrl = asString(config.graphql_endpoint_url, "").trim();
  if (graphqlEndpointUrl) {
    const graphqlNote = `\n## Pre-configured GraphQL Endpoint\nEndpoint URL: \`${graphqlEndpointUrl}\`. Use the \`query_graphql\` tool to query/mutate data or \`inspect_api_documentation\` to explore schema.`;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n---\n${graphqlNote}` : graphqlNote;
  }

  const toolNames = tools.map((t: any) => t.function?.name || "tool").join(", ");

  const controller = new AbortController();
  const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;

  try {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalAssistantText = "";
    let artifactSaved = false;
    let turn = 0;
    const maxTurns = asNumber(effectiveConfig.max_turns, 10);

    while (turn < maxTurns) {
      turn++;
      const isFirstTurn = turn === 1;
      const isFinalTurn = turn === maxTurns;

      // Guarantee that messages always contains at least one non-empty user query.
      // This protects Qwen models whose Jinja chat template raises:
      // "ValueError: No user query found in messages" when context pruning or tool loops occur.
      const hasUserMessage = messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0);
      if (!hasUserMessage) {
        messages.splice(1, 0, {
          role: "user",
          content: promptText || "Analyze the tool outputs and provide a complete response.",
        });
      }

      // On the final turn, restrict tools to save_artifact only to encourage report synthesis
      const currentTools = isFinalTurn
        ? (issueId ? [SAVE_ARTIFACT_TOOL_DEFINITION] : [])
        : tools;

      const requestBody: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        options,
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
        ...(currentTools.length > 0 ? { tools: currentTools } : {}),
      };

      if (isFirstTurn) {
        onDispatch?.();
        await onLog(
          "stdout",
          `[omnia] Invoking model "${model}" at ${host} (tools: ${tools.length > 0 ? `enabled [${toolNames}]` : "disabled"})...\n`,
        );
      } else {
        await onLog(
          "stdout",
          `[omnia] Turn ${turn}: Processing tool results with model "${model}"...\n`,
        );
      }

      prunePriorToolMessages(messages);

      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        if (res.status === 404 && (errorText.includes("not found") || errorText.includes("model"))) {
          const tags = await fetchOllamaTags(host);
          const availableList = tags.map((t) => t.id).join(", ");
          const detailedMsg = `Ollama error on host ${host}: Model "${model}" was not found (HTTP 404).\nAvailable models installed on ${host}: [${availableList || "none found"}].\nTo fix this: pull the model on the remote server with 'ollama pull ${model}', or select one of the available models in Paperclip.`;
          await onLog("stderr", `[omnia] ${detailedMsg}\n`);
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: detailedMsg,
            errorCode: "ollama_model_not_found",
          };
        }

        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Ollama chat API error (HTTP ${res.status}): ${errorText}`,
          errorCode: "ollama_api_error",
        };
      }

      if (!res.body) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Ollama returned an empty response body",
          errorCode: "ollama_empty_body",
        };
      }

      let turnAssistantText = "";
      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      let lineBuffer = "";
      const capturedToolCalls: ToolCall[] = [];

      const reader = res.body as unknown as AsyncIterable<Uint8Array>;
      const decoder = new TextDecoder("utf-8");

      for await (const chunk of reader) {
        lineBuffer += decoder.decode(chunk, { stream: true });
        let newlineIndex: number;

        while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
          const line = lineBuffer.slice(0, newlineIndex).trim();
          lineBuffer = lineBuffer.slice(newlineIndex + 1);

          if (!line) continue;

          try {
            const parsed = JSON.parse(line) as OllamaStreamChunk;

            if (parsed.error) {
              await onLog("stderr", `[omnia] Model error: ${parsed.error}\n`);
              return {
                exitCode: 1,
                signal: null,
                timedOut: false,
                errorMessage: parsed.error,
                errorCode: "ollama_model_error",
              };
            }

            if (parsed.message?.content) {
              turnAssistantText += parsed.message.content;
              await onLog("stdout", parsed.message.content);
            }

            if (parsed.message?.tool_calls && Array.isArray(parsed.message.tool_calls)) {
              for (const call of parsed.message.tool_calls) {
                capturedToolCalls.push(call);
              }
            }

            if (parsed.done) {
              turnInputTokens = parsed.prompt_eval_count ?? 0;
              turnOutputTokens = parsed.eval_count ?? 0;
            }
          } catch {
            // Non-JSON line or incomplete chunk
          }
        }
      }

      // Flush remaining line buffer
      if (lineBuffer.trim()) {
        try {
          const parsed = JSON.parse(lineBuffer.trim()) as OllamaStreamChunk;
          if (parsed.message?.content) {
            turnAssistantText += parsed.message.content;
            await onLog("stdout", parsed.message.content);
          }
          if (parsed.message?.tool_calls && Array.isArray(parsed.message.tool_calls)) {
            for (const call of parsed.message.tool_calls) {
              capturedToolCalls.push(call);
            }
          }
          if (parsed.done) {
            turnInputTokens = parsed.prompt_eval_count ?? turnInputTokens;
            turnOutputTokens = parsed.eval_count ?? turnOutputTokens;
          }
        } catch {
          // ignore trailing unparseable
        }
      }

      totalInputTokens += turnInputTokens;
      totalOutputTokens += turnOutputTokens;

      if (turnAssistantText.trim()) {
        finalAssistantText = turnAssistantText;
      }

      // Filter out dummy/hallucinated tool calls (e.g. {"name": "None"}, null, or empty name)
      const validToolCalls = capturedToolCalls.filter(
        (c) => c.function?.name && c.function.name !== "None" && c.function.name !== "null" && c.function.name.trim().length > 0,
      );

      // If no valid tools were called in this turn, execution is complete
      if (validToolCalls.length === 0) {
        break;
      }

      // Append assistant message with its valid tool calls
      messages.push({
        role: "assistant",
        content: turnAssistantText || "",
        tool_calls: validToolCalls,
      });

      // Execute each tool and append tool results
      for (const call of validToolCalls) {
        let args: Record<string, unknown> = {};
        if (typeof call.function.arguments === "string") {
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = {};
          }
        } else if (typeof call.function.arguments === "object" && call.function.arguments) {
          args = call.function.arguments as Record<string, unknown>;
        }

        const toolName = call.function?.name || "";
        const callId = call.id || `${toolName}-call`;

        await onLog(
          "stdout",
          `\n[omnia:tool_call] ${JSON.stringify({ name: toolName, arguments: args, id: callId })}\n`,
        );

        let toolResult: unknown;
        try {
          if (toolName === "set_task_title") {
            toolResult = await handleSetTaskTitle(args, {
              issueId,
              apiUrl,
              authToken,
            });
          } else if (toolName === "save_artifact" || toolName === "upsert_document" || toolName === "create_document") {
            artifactSaved = true;
            toolResult = await handleSaveArtifact(args, {
              issueId,
              apiUrl,
              authToken,
              workspacePath: asString(context.workspacePath || context.cwd || (runtime as any).cwd, "") || undefined,
            });
          } else if (toolName === "omnia") {
            toolResult = await executeOmniaOperation(args, effectiveConfig);
          } else {
            // Dispatches to the Tool Registry (handles name lookup, enabled check, access validation, auth injection)
            toolResult = await executeToolByName(toolName, args, configuredTools, effectiveConfig);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResult = { error: `OmnIA tool execution failed: ${msg}` };
        }

        const maxBytes = asNumber(effectiveConfig.omnia_max_response_bytes, 6000);
        const compacted = compactToolResponse(toolResult, maxBytes);
        const toolResultStr = typeof compacted === "string" ? compacted : JSON.stringify(compacted);

        await onLog(
          "stdout",
          `[omnia:tool_result] ${toolResultStr}\n\n`,
        );

        messages.push({
          role: "tool",
          name: toolName,
          content: toolResultStr,
        });
      }

      // If reaching the penultimate turn, prompt the model to finalize and save its report
      if (turn === maxTurns - 1) {
        messages.push({
          role: "user",
          content: "You have gathered the necessary data. Now synthesize all findings, generate your complete structured Security Advisory Report in markdown, and save it as an artifact using `save_artifact`.",
        });
      }
    }

    // If the loop terminated while the last message was a tool result,
    // invoke the model for one final synthesis pass so output is never truncated.
    if (messages[messages.length - 1]?.role === "tool") {
      await onLog("stdout", `[omnia] Generating final synthesis response...\n`);
      try {
        prunePriorToolMessages(messages);
        const synthRes = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            options,
            ...(keepAlive ? { keep_alive: keepAlive } : {}),
            ...(issueId ? { tools: [SAVE_ARTIFACT_TOOL_DEFINITION] } : {}),
          }),
          signal: controller.signal,
        });

        if (synthRes.ok && synthRes.body) {
          let synthText = "";
          let synthBuffer = "";
          const synthReader = synthRes.body as unknown as AsyncIterable<Uint8Array>;
          const synthDecoder = new TextDecoder("utf-8");
          const synthToolCalls: ToolCall[] = [];

          for await (const chunk of synthReader) {
            synthBuffer += synthDecoder.decode(chunk, { stream: true });
            let nlIdx: number;
            while ((nlIdx = synthBuffer.indexOf("\n")) !== -1) {
              const line = synthBuffer.slice(0, nlIdx).trim();
              synthBuffer = synthBuffer.slice(nlIdx + 1);
              if (!line) continue;
              try {
                const parsed = JSON.parse(line) as OllamaStreamChunk;
                if (parsed.message?.content) {
                  synthText += parsed.message.content;
                  await onLog("stdout", parsed.message.content);
                }
                if (parsed.message?.tool_calls && Array.isArray(parsed.message.tool_calls)) {
                  for (const tc of parsed.message.tool_calls) {
                    synthToolCalls.push(tc);
                  }
                }
              } catch {}
            }
          }

          if (synthText.trim()) {
            finalAssistantText = synthText.trim();
          }

          // Handle save_artifact call if invoked during synthesis pass
          for (const tc of synthToolCalls) {
            const tcName = tc.function?.name || "";
            if (tcName === "save_artifact" || tcName === "upsert_document" || tcName === "create_document") {
              let tcArgs: Record<string, unknown> = {};
              try {
                tcArgs = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {});
              } catch {}
              const saveRes = await handleSaveArtifact(tcArgs, {
                issueId,
                apiUrl,
                authToken,
                workspacePath: asString(context.workspacePath || context.cwd || (runtime as any).cwd, "") || undefined,
              });
              if (saveRes.success) {
                artifactSaved = true;
                await onLog("stdout", `\n[omnia] Successfully saved artifact document "${saveRes.key}" (rev ${saveRes.revision ?? 1}).\n`);
              }
            }
          }
        }
      } catch (err) {
        await onLog("stderr", `[omnia] Note: Final synthesis pass failed: ${err}\n`);
      }
    }

    await onLog("stdout", "\n");

    // Auto-promote structured markdown reports to Paperclip issue artifacts/documents
    // if the model generated a report in its final answer without explicitly calling save_artifact
    if (!artifactSaved && issueId && isStructuredMarkdownReport(finalAssistantText)) {
      try {
        const autoTitle = deriveTitleFromMarkdown(finalAssistantText) || "Security & Analysis Report";
        const autoKey = normalizeArtifactKey(undefined, autoTitle);
        const autoContent = extractReportMarkdown(finalAssistantText);
        const autoResult = await handleSaveArtifact(
          {
            title: autoTitle,
            content: autoContent,
            key: autoKey,
            changeSummary: "Auto-generated report artifact from task execution",
          },
          {
            issueId,
            apiUrl,
            authToken,
            workspacePath: asString(context.workspacePath || context.cwd || (runtime as any).cwd, "") || undefined,
          },
        );
        if (autoResult.success) {
          artifactSaved = true;
          await onLog(
            "stdout",
            `[omnia] Automatically published markdown report as Paperclip artifact/document "${autoResult.key}" (rev ${autoResult.revision ?? 1}).\n`,
          );
        }
      } catch (err) {
        await onLog("stderr", `[omnia] Note: Auto-publish artifact skipped: ${err}\n`);
      }
    }

    // Automatically transition issue status to 'done' when substantive output was produced.
    // This prevents Paperclip's recovery worker from triggering retry cascades (disposition_repair).
    if (issueId && finalAssistantText.trim()) {
      try {
        const marked = await markIssueDone({
          issueId,
          apiUrl,
          authToken,
        });
        if (marked) {
          await onLog("stdout", `[omnia] Successfully marked issue ${issueId} as done.\n`);
        }
      } catch (err) {
        await onLog("stderr", `[omnia] Warning: Could not mark issue ${issueId} as done: ${err}\n`);
      }
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "ollama",
      model,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      summary: finalAssistantText,
      reportedWorkDisposition: "done",
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Ollama invocation timed out after ${timeoutSec} seconds`,
        errorCode: "timeout",
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[omnia] Execution error: ${message}\n`);

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama execution failed: ${message}`,
      errorCode: "ollama_execution_failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
