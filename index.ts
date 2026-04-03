// @ts-ignore OpenClaw provides this module at plugin runtime.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  OpenVikingClient,
  type CommitSessionResult,
  type FindResult,
  type FindResultItem,
} from "./client.js";
import {
  buildMemoryLinesWithBudget,
  clampScore,
  cleanupExpiredPrePromptCounts,
  consumePrePromptCount,
  dedupeMemoriesByUri,
  estimateTokenCount,
  formatMemoryLines,
  matchesAnyPattern,
  rememberPrePromptCount,
  selectToolMemories,
  type PrePromptCountEntry,
} from "./src/helpers.js";

type HookContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type PluginLoggerLike = {
  warn?: (message: string) => void;
};

type BeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type BeforePromptBuildResult = {
  prependContext?: string;
};

type AgentEndEvent = {
  messages: unknown[];
};

type ToolTextContent = {
  type: "text";
  text: string;
};

type ToolResult = {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

type ToolContext = HookContext;

type OpenClawPluginApiLike = {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLoggerLike;
  registerTool: {
    (tool: ToolDefinition, opts?: { name?: string; names?: string[] }): void;
    (
      factory: (ctx: ToolContext) => ToolDefinition,
      opts?: { name?: string; names?: string[] },
    ): void;
  };
  on(
    hookName: "before_prompt_build",
    handler: (
      event: BeforePromptBuildEvent,
      ctx: HookContext,
    ) => Promise<BeforePromptBuildResult | void> | BeforePromptBuildResult | void,
  ): void;
  on(
    hookName: "agent_end",
    handler: (event: AgentEndEvent, ctx: HookContext) => Promise<void> | void,
  ): void;
};

type PluginConfig = {
  baseUrl: string;
  apiKey: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureSessionFilter: string[];
  recallLimit: number;
  recallScoreThreshold: number;
  recallTokenBudget: number;
  recallMaxContentChars: number;
  commitTokenThreshold: number;
};

type CaptureMode = "semantic" | "keyword";

type CapturedTurnMessage = {
  role: "user" | "assistant";
  content: string;
};

const DEFAULT_CONFIG: PluginConfig = {
  baseUrl: "http://127.0.0.1:1933",
  apiKey: "",
  autoRecall: true,
  autoCapture: true,
  captureSessionFilter: [],
  recallLimit: 6,
  recallScoreThreshold: 0.15,
  recallTokenBudget: 2_000,
  recallMaxContentChars: 500,
  commitTokenThreshold: 20000,
};

const DEFAULT_CAPTURE_MODE: CaptureMode = "semantic";
const DEFAULT_CAPTURE_MAX_LENGTH = 24_000;
const DEFAULT_RECALL_PREFER_ABSTRACT = true;
const QUICK_RECALL_PRECHECK_TIMEOUT_MS = 1_500;
const AUTO_RECALL_TIMEOUT_MS = 15_000;
const PRE_PROMPT_COUNT_TTL_MS = 30 * 60_000;
const USER_MEMORIES_URI = "viking://user/memories";
const AGENT_MEMORIES_URI = "viking://agent/memories";

export default definePluginEntry({
  id: "openclaw-openviking-plugin",
  name: "OpenViking Memory",
  description:
    "Long-term memory via a running OpenViking HTTP server — hooks plus memory tools",
  register(api: OpenClawPluginApiLike) {
    const cfg = resolvePluginConfig(api.pluginConfig);
    const client = new OpenVikingClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
    });
    const prePromptCounts = new Map<string, PrePromptCountEntry>();

    api.registerTool((ctx: ToolContext) => ({
      name: "memory_recall",
      label: "Memory Recall (OpenViking)",
      description:
        "Search OpenViking long-term memories for relevant user facts, preferences, and prior decisions.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return",
          },
          scoreThreshold: {
            type: "number",
            description: "Minimum score between 0 and 1",
          },
          targetUri: {
            type: "string",
            description:
              "Optional search scope URI. Defaults to both viking://user/memories and viking://agent/memories",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
        const query = normalizeNonEmptyString(params.query);
        if (!query) {
          return textToolResult("Provide a non-empty query.", {
            error: "missing_query",
          });
        }

        const limit = clampInteger(params.limit, cfg.recallLimit, 1, 50);
        const scoreThreshold = clampNumber(
          params.scoreThreshold,
          cfg.recallScoreThreshold,
          0,
          1,
        );
        const targetUri = normalizeNonEmptyString(params.targetUri) || undefined;
        const requestLimit = Math.max(limit * 4, 20);
        const agentId = resolveToolAgentId(ctx);

        try {
          if (targetUri) {
            const result = await client.find(query, targetUri, requestLimit, 0, agentId);
            const memories = selectToolMemories(result.memories ?? [], {
              limit,
              scoreThreshold,
            });
            if (memories.length === 0) {
              return textToolResult("No relevant OpenViking memories found.", {
                count: 0,
                scoreThreshold,
                targetUri,
              });
            }
            return textToolResult(
              `Found ${memories.length} memories:\n\n${formatMemoryLines(memories)}`,
              {
                count: memories.length,
                memories,
                requestLimit,
                scoreThreshold,
                targetUri,
              },
            );
          }

          const [userSettled, agentSettled] = await Promise.allSettled([
            client.find(query, USER_MEMORIES_URI, requestLimit, 0, agentId),
            client.find(query, AGENT_MEMORIES_URI, requestLimit, 0, agentId),
          ]);

          if (userSettled.status === "rejected") {
            api.logger.warn?.(
              `openclaw-openviking-plugin: memory_recall user search failed: ${String(
                userSettled.reason,
              )}`,
            );
          }
          if (agentSettled.status === "rejected") {
            api.logger.warn?.(
              `openclaw-openviking-plugin: memory_recall agent search failed: ${String(
                agentSettled.reason,
              )}`,
            );
          }
          if (userSettled.status === "rejected" && agentSettled.status === "rejected") {
            return textToolResult("OpenViking memory recall failed.", {
              error: "both_searches_failed",
            });
          }

          const memories = selectToolMemories(
            dedupeMemoriesByUri([
              ...(unwrapFindResult(userSettled).memories ?? []),
              ...(unwrapFindResult(agentSettled).memories ?? []),
            ]),
            {
              limit,
              scoreThreshold,
            },
          );

          if (memories.length === 0) {
            return textToolResult("No relevant OpenViking memories found.", {
              count: 0,
              scoreThreshold,
              targetUri: null,
            });
          }

          return textToolResult(
            `Found ${memories.length} memories:\n\n${formatMemoryLines(memories)}`,
            {
              count: memories.length,
              memories,
              requestLimit,
              scoreThreshold,
              targetUri: null,
            },
          );
        } catch (error) {
          api.logger.warn?.(
            `openclaw-openviking-plugin: memory_recall failed: ${String(error)}`,
          );
          return textToolResult("OpenViking memory recall failed.", {
            error: String(error),
          });
        }
      },
    }));

    api.registerTool((ctx: ToolContext) => ({
      name: "memory_store",
      label: "Memory Store (OpenViking)",
      description:
        "Write text into an OpenViking session and run memory extraction immediately.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Text to store",
          },
          role: {
            type: "string",
            description: "Message role, defaults to user",
          },
          sessionId: {
            type: "string",
            description: "Optional existing session ID. A temporary session ID is generated if omitted",
          },
        },
        required: ["text"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
        const text = normalizeNonEmptyString(params.text);
        if (!text) {
          return textToolResult("Provide non-empty text to store.", {
            error: "missing_text",
          });
        }

        const role = normalizeNonEmptyString(params.role) || "user";
        const providedSessionId = normalizeNonEmptyString(params.sessionId);
        const sessionId =
          providedSessionId ||
          `memory-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const usedTempSession = !providedSessionId;
        const agentId = resolveToolAgentId(ctx);

        try {
          await client.addSessionMessage(sessionId, role, text, agentId);
          const commitResult = await client.commitSession(sessionId, {
            wait: true,
            agentId,
          });
          const memoriesCount = totalCommitMemories(commitResult);

          if (commitResult.status === "failed") {
            return textToolResult(
              `Memory extraction failed for session ${sessionId}: ${commitResult.error ?? "unknown"}`,
              {
                action: "failed",
                error: commitResult.error ?? "unknown",
                sessionId,
                status: commitResult.status,
                usedTempSession,
              },
            );
          }

          if (commitResult.status === "timeout") {
            return textToolResult(
              `Memory extraction timed out for session ${sessionId}. It may still complete in the background (task_id=${commitResult.task_id ?? "none"}).`,
              {
                action: "timeout",
                sessionId,
                status: commitResult.status,
                taskId: commitResult.task_id ?? null,
                usedTempSession,
              },
            );
          }

          return textToolResult(
            `Stored text in OpenViking session ${sessionId}. Commit completed with ${memoriesCount} extracted memories.`,
            {
              action: "stored",
              archived: commitResult.archived ?? false,
              memoriesCount,
              sessionId,
              status: commitResult.status,
              usedTempSession,
            },
          );
        } catch (error) {
          api.logger.warn?.(
            `openclaw-openviking-plugin: memory_store failed: ${String(error)}`,
          );
          return textToolResult("OpenViking memory store failed.", {
            error: String(error),
            sessionId,
            usedTempSession,
          });
        }
      },
    }));

    api.registerTool((ctx: ToolContext) => ({
      name: "memory_forget",
      label: "Memory Forget (OpenViking)",
      description:
        "Delete a memory by URI, or search for a strong match and delete it after confirmation.",
      parameters: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "Exact memory URI to delete",
          },
          query: {
            type: "string",
            description: "Search query used to locate a memory before deletion",
          },
          confirm: {
            type: "boolean",
            description:
              "Required when deleting based on a query match. The tool only auto-deletes a single strong match when confirm is true",
          },
        },
      },
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
        const uri = normalizeNonEmptyString(params.uri);
        const query = normalizeNonEmptyString(params.query);
        const confirm = params.confirm === true;
        const agentId = resolveToolAgentId(ctx);

        try {
          if (uri) {
            await client.delete(uri, agentId);
            return textToolResult(`Forgotten: ${uri}`, {
              action: "deleted",
              uri,
            });
          }

          if (!query) {
            return textToolResult("Provide either uri or query.", {
              error: "missing_uri_or_query",
            });
          }

          const requestLimit = 20;
          const [userSettled, agentSettled] = await Promise.allSettled([
            client.find(query, USER_MEMORIES_URI, requestLimit, 0, agentId),
            client.find(query, AGENT_MEMORIES_URI, requestLimit, 0, agentId),
          ]);

          if (userSettled.status === "rejected") {
            api.logger.warn?.(
              `openclaw-openviking-plugin: memory_forget user search failed: ${String(
                userSettled.reason,
              )}`,
            );
          }
          if (agentSettled.status === "rejected") {
            api.logger.warn?.(
              `openclaw-openviking-plugin: memory_forget agent search failed: ${String(
                agentSettled.reason,
              )}`,
            );
          }
          if (userSettled.status === "rejected" && agentSettled.status === "rejected") {
            return textToolResult("OpenViking memory forget failed.", {
              error: "both_searches_failed",
            });
          }

          const candidates = selectToolMemories(
            dedupeMemoriesByUri([
              ...(unwrapFindResult(userSettled).memories ?? []),
              ...(unwrapFindResult(agentSettled).memories ?? []),
            ]),
            {
              limit: 5,
              scoreThreshold: 0,
            },
          );

          if (candidates.length === 0) {
            return textToolResult("No matching OpenViking memories found.", {
              action: "none",
              query,
            });
          }

          const top = candidates[0];
          const topScore = clampScore(top.score);
          if (candidates.length === 1 && topScore > 0.8 && confirm) {
            await client.delete(top.uri, agentId);
            return textToolResult(`Forgotten: ${top.uri}`, {
              action: "deleted",
              query,
              score: topScore,
              uri: top.uri,
            });
          }

          const confirmationHint =
            candidates.length === 1 && topScore > 0.8
              ? "Strong match found. Re-run with confirm=true to delete it, or pass uri to delete directly."
              : "Multiple or weak matches found. Pass uri to delete the intended memory.";

          return textToolResult(
            `${confirmationHint}\n\nCandidates:\n${formatMemoryLines(candidates)}`,
            {
              action: "candidates",
              candidates,
              confirm,
              query,
            },
          );
        } catch (error) {
          api.logger.warn?.(
            `openclaw-openviking-plugin: memory_forget failed: ${String(error)}`,
          );
          return textToolResult("OpenViking memory forget failed.", {
            error: String(error),
          });
        }
      },
    }));

    api.on("before_prompt_build", async (event: BeforePromptBuildEvent, ctx: HookContext) => {
      const sessionId = normalizeNonEmptyString(ctx.sessionId);
      cleanupExpiredPrePromptCounts(prePromptCounts, PRE_PROMPT_COUNT_TTL_MS);
      if (sessionId) {
        rememberPrePromptCount(
          prePromptCounts,
          sessionId,
          Array.isArray(event.messages) ? event.messages.length : 0,
        );
      }

      if (!cfg.autoRecall) {
        return;
      }

      const queryText =
        extractLatestUserText(event.messages) || normalizeNonEmptyString(event.prompt) || "";
      if (!queryText) {
        return;
      }
      api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] queryText (first 200 chars): ${queryText.slice(0, 200)}`);

      const runtimeAgentId = resolveRuntimeAgentId(ctx);

      try {
        const ovReachable = await quickRecallPrecheck(client, runtimeAgentId);
        api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] ovReachable=${ovReachable}, agentId=${runtimeAgentId}`);
        if (!ovReachable) {
          api.logger.warn?.("openclaw-openviking-plugin: OV unreachable, skipping autoRecall");
          return;
        }

        const candidateLimit = Math.max(cfg.recallLimit * 4, 20);
        api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] candidateLimit=${candidateLimit}, scoreThreshold=${cfg.recallScoreThreshold}, recallLimit=${cfg.recallLimit}`);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const settledResults = await Promise.race([
          Promise.allSettled([
            client.find(queryText, USER_MEMORIES_URI, candidateLimit, 0, runtimeAgentId),
            client.find(queryText, AGENT_MEMORIES_URI, candidateLimit, 0, runtimeAgentId),
          ]).then((result) => ({
            timedOut: false as const,
            result,
          })),
          new Promise<{ timedOut: true }>((resolve) => {
            timeoutId = setTimeout(() => resolve({ timedOut: true }), AUTO_RECALL_TIMEOUT_MS);
          }),
        ]);
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (settledResults.timedOut) {
          api.logger.warn?.("openclaw-openviking-plugin: autoRecall timed out, skipping");
          return;
        }

        const [userSettled, agentSettled] = settledResults.result;

        const userResult = unwrapFindResult(userSettled);
        const agentResult = unwrapFindResult(agentSettled);
        if (userSettled.status === "rejected") {
          api.logger.warn?.(
            `openclaw-openviking-plugin: user memory search failed: ${String(userSettled.reason)}`,
          );
        }
        if (agentSettled.status === "rejected") {
          api.logger.warn?.(
            `openclaw-openviking-plugin: agent memory search failed: ${String(agentSettled.reason)}`,
          );
        }

        const merged = dedupeMemoriesByUri([
          ...(userResult.memories ?? []),
          ...(agentResult.memories ?? []),
        ]);
        api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] merged=${merged.length}, user=${(userResult.memories??[]).length}, agent=${(agentResult.memories??[]).length}`);
        if (merged.length > 0) {
          api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] top3 merged: ${merged.slice(0,3).map(m => `${m.score?.toFixed(3)}|L${m.level}|${(m.abstract||'').slice(0,40)}`).join(' /// ')}`);
        }
        const leafOnly = merged.filter((item) => item.level === 2);
        const processed = postProcessMemories(leafOnly, {
          limit: candidateLimit,
          scoreThreshold: cfg.recallScoreThreshold,
        });
        const selected = pickMemoriesForInjection(processed, cfg.recallLimit, queryText);
        api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] leafOnly=${leafOnly.length}, processed=${processed.length}, selected=${selected.length}`);
        if (selected.length > 0) {
          api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] selected: ${selected.slice(0,3).map(m => `${m.score?.toFixed(3)}|${(m.abstract||'').slice(0,40)}`).join(' /// ')}`);
        }
        if (selected.length === 0) {
          return;
        }

        const { lines } = await buildMemoryLinesWithBudget(
          selected,
          (uri) => client.read(uri, runtimeAgentId),
          {
            recallPreferAbstract: DEFAULT_RECALL_PREFER_ABSTRACT,
            recallMaxContentChars: cfg.recallMaxContentChars,
            recallTokenBudget: cfg.recallTokenBudget,
          },
        );
        api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] lines=${lines.length}`);
        if (lines.length > 0) {
          api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] first 3 lines: ${lines.slice(0,3).join(' ||| ')}`);
        }
        if (lines.length === 0) {
          return;
        }

        const prependContext =
            "<relevant-memories>\n" +
            "The following OpenViking memories may be relevant:\n" +
            `${lines.join("\n")}\n` +
            "</relevant-memories>";
        api.logger.warn?.(`openclaw-openviking-plugin: [DEBUG] returning prependContext (${prependContext.length} chars)`);
        return { prependContext };
      } catch (error) {
        api.logger.warn?.(
          `openclaw-openviking-plugin: autoRecall failed: ${String(error)}`,
        );
      }
    });

    api.on("agent_end", async (event: AgentEndEvent, ctx: HookContext) => {
      if (!cfg.autoCapture) {
        return;
      }

      if (cfg.captureSessionFilter.length > 0) {
        const key = ctx.sessionKey ?? "";
        if (!matchesAnyPattern(key, cfg.captureSessionFilter)) {
          return;
        }
      }

      const sessionId = normalizeNonEmptyString(ctx.sessionId);
      if (!sessionId) {
        return;
      }

      const messages = Array.isArray(event.messages) ? event.messages : [];
      cleanupExpiredPrePromptCounts(prePromptCounts, PRE_PROMPT_COUNT_TTL_MS);
      const recorded = consumePrePromptCount(prePromptCounts, sessionId);
      const preCount =
        recorded != null && recorded > 0
          ? recorded
          : Math.max(0, messages.length - 2);

      try {
        const { texts: newTexts } = extractNewTurnTexts(messages, preCount);
        if (newTexts.length === 0) {
          return;
        }

        const runtimeAgentId = resolveRuntimeAgentId(ctx);
        const newMessages = extractNewTurnMessages(messages, preCount);
        const captured = newMessages
          .map((message) => {
            const decision = getCaptureDecision(
              message.content,
              DEFAULT_CAPTURE_MODE,
              DEFAULT_CAPTURE_MAX_LENGTH,
            );
            if (!decision.shouldCapture) {
              return null;
            }
            return {
              role: message.role,
              content: decision.normalizedText,
            };
          })
          .filter((value): value is CapturedTurnMessage => value !== null);

        if (captured.length === 0) {
          return;
        }

        for (const message of captured) {
          await client.addSessionMessage(
            sessionId,
            message.role,
            message.content,
            runtimeAgentId,
          );
        }

        const estimatedTokens = estimateTokenCount(
          captured.map((message) => message.content).join("\n"),
        );
        if (estimatedTokens < cfg.commitTokenThreshold) {
          return;
        }

        await client.commitSession(sessionId, runtimeAgentId);
      } catch (error) {
        api.logger.warn?.(
          `openclaw-openviking-plugin: autoCapture via agent_end failed: ${String(error)}`,
        );
      }
    });
  },
});

function resolvePluginConfig(pluginConfig: Record<string, unknown> | undefined): PluginConfig {
  const raw =
    pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
      ? pluginConfig
      : {};

  return {
    baseUrl: normalizeNonEmptyString(raw.baseUrl) || DEFAULT_CONFIG.baseUrl,
    apiKey: normalizeNonEmptyString(raw.apiKey) || DEFAULT_CONFIG.apiKey,
    autoRecall: toBoolean(raw.autoRecall, DEFAULT_CONFIG.autoRecall),
    autoCapture: toBoolean(raw.autoCapture, DEFAULT_CONFIG.autoCapture),
    captureSessionFilter: Array.isArray(raw.captureSessionFilter)
      ? raw.captureSessionFilter.filter((value): value is string => typeof value === "string")
      : [...DEFAULT_CONFIG.captureSessionFilter],
    recallLimit: clampInteger(raw.recallLimit, DEFAULT_CONFIG.recallLimit, 1, 50),
    recallScoreThreshold: clampNumber(
      raw.recallScoreThreshold,
      DEFAULT_CONFIG.recallScoreThreshold,
      0,
      1,
    ),
    recallTokenBudget: clampInteger(
      raw.recallTokenBudget,
      DEFAULT_CONFIG.recallTokenBudget,
      1,
      20_000,
    ),
    recallMaxContentChars: clampInteger(
      raw.recallMaxContentChars,
      DEFAULT_CONFIG.recallMaxContentChars,
      50,
      20_000,
    ),
    commitTokenThreshold: clampInteger(
      raw.commitTokenThreshold,
      DEFAULT_CONFIG.commitTokenThreshold,
      0,
      100_000,
    ),
  };
}

function resolveRuntimeAgentId(ctx: HookContext): string | undefined {
  return normalizeNonEmptyString(ctx.agentId);
}

function resolveToolAgentId(ctx: ToolContext): string | undefined {
  return normalizeNonEmptyString(ctx.agentId) || undefined;
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Math.floor(toNumber(value, fallback));
  return Math.max(min, Math.min(max, numeric));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = toNumber(value, fallback);
  return Math.max(min, Math.min(max, numeric));
}

async function quickRecallPrecheck(
  client: OpenVikingClient,
  agentId?: string,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      client
        .getStatus(agentId)
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), QUICK_RECALL_PRECHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function unwrapFindResult(result: PromiseSettledResult<FindResult>): FindResult {
  return result.status === "fulfilled" ? result.value : { memories: [] };
}

function textToolResult(text: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function totalCommitMemories(result: CommitSessionResult): number {
  let total = 0;
  for (const value of Object.values(result.memories_extracted ?? {})) {
    total += typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  return total;
}

function normalizeDedupeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isEventOrCaseMemory(item: FindResultItem): boolean {
  const category = (item.category ?? "").toLowerCase();
  const uri = item.uri.toLowerCase();
  return (
    category === "events" ||
    category === "cases" ||
    uri.includes("/events/") ||
    uri.includes("/cases/")
  );
}

function getMemoryDedupeKey(item: FindResultItem): string {
  const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "");
  const category = (item.category ?? "").toLowerCase() || "unknown";
  if (abstract && !isEventOrCaseMemory(item)) {
    return `abstract:${category}:${abstract}`;
  }
  return `uri:${item.uri}`;
}

function postProcessMemories(
  items: FindResultItem[],
  options: {
    limit: number;
    scoreThreshold: number;
    leafOnly?: boolean;
  },
): FindResultItem[] {
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => clampScore(b.score) - clampScore(a.score));
  for (const item of sorted) {
    if (options.leafOnly && item.level !== 2) {
      continue;
    }
    if (clampScore(item.score) < options.scoreThreshold) {
      continue;
    }
    const key = getMemoryDedupeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= options.limit) {
      break;
    }
  }
  return deduped;
}

function isPreferencesMemory(item: FindResultItem): boolean {
  return (
    item.category === "preferences" ||
    item.uri.includes("/preferences/") ||
    item.uri.endsWith("/preferences")
  );
}

function isEventMemory(item: FindResultItem): boolean {
  const category = (item.category ?? "").toLowerCase();
  return category === "events" || item.uri.includes("/events/");
}

function isLeafLikeMemory(item: FindResultItem): boolean {
  return item.level === 2;
}

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i;
const TEMPORAL_QUERY_RE =
  /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上周|下周|上个月|下个月|去年|明年/i;
const QUERY_TOKEN_RE = /[a-z0-9]{2,}/gi;
const QUERY_TOKEN_STOPWORDS = new Set([
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "did",
  "does",
  "is",
  "are",
  "was",
  "were",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
]);

type RecallQueryProfile = {
  tokens: string[];
  wantsPreference: boolean;
  wantsTemporal: boolean;
};

function buildRecallQueryProfile(query: string): RecallQueryProfile {
  const text = query.trim();
  const allTokens = text.toLowerCase().match(QUERY_TOKEN_RE) ?? [];
  const tokens = allTokens.filter((token) => !QUERY_TOKEN_STOPWORDS.has(token));
  return {
    tokens,
    wantsPreference: PREFERENCE_QUERY_RE.test(text),
    wantsTemporal: TEMPORAL_QUERY_RE.test(text),
  };
}

function lexicalOverlapBoost(tokens: string[], text: string): number {
  if (tokens.length === 0 || !text) {
    return 0;
  }
  const haystack = ` ${text.toLowerCase()} `;
  let matched = 0;
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(` ${token} `) || haystack.includes(token)) {
      matched += 1;
    }
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}

function rankForInjection(item: FindResultItem, query: RecallQueryProfile): number {
  const baseScore = clampScore(item.score);
  const abstract = (item.abstract ?? item.overview ?? "").trim();
  const leafBoost = isLeafLikeMemory(item) ? 0.12 : 0;
  const eventBoost = query.wantsTemporal && isEventMemory(item) ? 0.1 : 0;
  const preferenceBoost = query.wantsPreference && isPreferencesMemory(item) ? 0.08 : 0;
  const overlapBoost = lexicalOverlapBoost(query.tokens, `${item.uri} ${abstract}`);
  return baseScore + leafBoost + eventBoost + preferenceBoost + overlapBoost;
}

function pickMemoriesForInjection(
  items: FindResultItem[],
  limit: number,
  queryText: string,
): FindResultItem[] {
  if (items.length === 0 || limit <= 0) {
    return [];
  }

  const query = buildRecallQueryProfile(queryText);
  const sorted = [...items].sort((a, b) => rankForInjection(b, query) - rankForInjection(a, query));
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();
  for (const item of sorted) {
    const abstractKey = (item.abstract ?? item.overview ?? "").trim().toLowerCase();
    const key = abstractKey || item.uri;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  const leaves = deduped.filter((item) => isLeafLikeMemory(item));
  if (leaves.length >= limit) {
    return leaves.slice(0, limit);
  }

  const picked = [...leaves];
  const used = new Set(leaves.map((item) => item.uri));
  for (const item of deduped) {
    if (picked.length >= limit) {
      break;
    }
    if (used.has(item.uri)) {
      continue;
    }
    picked.push(item);
  }
  return picked;
}

const MEMORY_TRIGGERS = [
  /remember|preference|prefer|important|decision|decided|always|never/i,
  /记住|偏好|喜欢|喜爱|崇拜|讨厌|害怕|重要|决定|总是|永远|优先|习惯|爱好|擅长|最爱|不喜欢/i,
  /[\w.-]+@[\w.-]+\.\w+/,
  /\+\d{10,}/,
  /(?:我|my)\s*(?:是|叫|名字|name|住在|live|来自|from|生日|birthday|电话|phone|邮箱|email)/i,
  /(?:我|i)\s*(?:喜欢|崇拜|讨厌|害怕|擅长|不会|爱|恨|想要|需要|希望|觉得|认为|相信)/i,
  /(?:favorite|favourite|love|hate|enjoy|dislike|admire|idol|fan of)/i,
];

const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const RELEVANT_MEMORIES_BLOCK_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi;
const CONVERSATION_METADATA_BLOCK_RE =
  /(?:^|\n)\s*(?:Conversation info|Conversation metadata|会话信息|对话信息)\s*(?:\([^)]+\))?\s*:\s*```[\s\S]*?```/gi;
const SENDER_METADATA_BLOCK_RE = /Sender\s*\([^)]*\)\s*:\s*```[\s\S]*?```/gi;
const REPLIED_MESSAGE_BLOCK_RE =
  /(?:^|\n)\s*Replied message[^\n]*:\s*```json[\s\S]*?```/gi;
const FENCED_JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/gi;
const METADATA_JSON_KEY_RE =
  /"(session|sessionid|sessionkey|conversationid|channel|sender|userid|agentid|timestamp|timezone)"\s*:/gi;
const LEADING_TIMESTAMP_PREFIX_RE = /^\s*\[[^\]\n]{1,120}\]\s*/;
const COMMAND_TEXT_RE = /^\/[a-z0-9_-]{1,64}\b/i;
const NON_CONTENT_TEXT_RE = /^[\p{P}\p{S}\s]+$/u;
const SUBAGENT_CONTEXT_RE = /^\s*\[Subagent Context\]/i;
const MEMORY_INTENT_RE = /记住|记下|remember|save|store|偏好|preference|规则|rule|事实|fact/i;
const QUESTION_CUE_RE =
  /[?？]|\b(?:what|when|where|who|why|how|which|can|could|would|did|does|is|are)\b|^(?:请问|能否|可否|怎么|如何|什么时候|谁|什么|哪|是否)/i;

function resolveCaptureMinLength(text: string): number {
  return CJK_CHAR_REGEX.test(text) ? 4 : 10;
}

function looksLikeMetadataJsonBlock(content: string): boolean {
  const matchedKeys = new Set<string>();
  const matches = content.matchAll(METADATA_JSON_KEY_RE);
  for (const match of matches) {
    const key = (match[1] ?? "").toLowerCase();
    if (key) {
      matchedKeys.add(key);
    }
  }
  return matchedKeys.size >= 3;
}

function sanitizeUserTextForCapture(text: string): string {
  return text
    .replace(RELEVANT_MEMORIES_BLOCK_RE, " ")
    .replace(CONVERSATION_METADATA_BLOCK_RE, " ")
    .replace(SENDER_METADATA_BLOCK_RE, " ")
    .replace(REPLIED_MESSAGE_BLOCK_RE, " ")
    .replace(FENCED_JSON_BLOCK_RE, (full, inner) =>
      looksLikeMetadataJsonBlock(String(inner ?? "")) ? " " : full,
    )
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeQuestionOnlyText(text: string): boolean {
  if (!QUESTION_CUE_RE.test(text) || MEMORY_INTENT_RE.test(text)) {
    return false;
  }
  const speakerTags = text.match(/[A-Za-z\u4e00-\u9fa5]{2,20}:\s/g) ?? [];
  if (speakerTags.length >= 2 || text.length > 280) {
    return false;
  }
  return true;
}

function getCaptureDecision(
  text: string,
  mode: CaptureMode,
  captureMaxLength: number,
): {
  shouldCapture: boolean;
  reason: string;
  normalizedText: string;
} {
  const trimmed = text.trim();
  const normalizedText = sanitizeUserTextForCapture(trimmed);
  const hadSanitization = normalizedText !== trimmed;

  if (!normalizedText) {
    return {
      shouldCapture: false,
      reason: /<relevant-memories>/i.test(trimmed) ? "injected_memory_context_only" : "empty_text",
      normalizedText: "",
    };
  }

  const compactText = normalizedText.replace(/\s+/g, "");
  const minLength = resolveCaptureMinLength(compactText);
  if (compactText.length < minLength || normalizedText.length > captureMaxLength) {
    return {
      shouldCapture: false,
      reason: "length_out_of_range",
      normalizedText,
    };
  }

  if (COMMAND_TEXT_RE.test(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "command_text",
      normalizedText,
    };
  }

  if (NON_CONTENT_TEXT_RE.test(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "non_content_text",
      normalizedText,
    };
  }

  if (SUBAGENT_CONTEXT_RE.test(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "subagent_context",
      normalizedText,
    };
  }

  if (looksLikeQuestionOnlyText(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "question_text",
      normalizedText,
    };
  }

  if (mode === "keyword") {
    for (const trigger of MEMORY_TRIGGERS) {
      if (trigger.test(normalizedText)) {
        return {
          shouldCapture: true,
          reason: hadSanitization
            ? `matched_trigger_after_sanitize:${trigger.toString()}`
            : `matched_trigger:${trigger.toString()}`,
          normalizedText,
        };
      }
    }

    return {
      shouldCapture: false,
      reason: hadSanitization ? "no_trigger_matched_after_sanitize" : "no_trigger_matched",
      normalizedText,
    };
  }

  return {
    shouldCapture: true,
    reason: hadSanitization ? "semantic_candidate_after_sanitize" : "semantic_candidate",
    normalizedText,
  };
}

function extractTextsFromUserMessages(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") {
      continue;
    }
    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const blockObj = block as Record<string, unknown>;
        if (blockObj.type === "text" && typeof blockObj.text === "string") {
          texts.push(blockObj.text);
        }
      }
    }
  }
  return texts;
}

function extractLatestUserText(messages: unknown[] | undefined): string {
  if (!messages || messages.length === 0) {
    return "";
  }

  const texts = extractTextsFromUserMessages(messages);
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const normalized = sanitizeUserTextForCapture(texts[i] ?? "");
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function formatToolUseBlock(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "unknown";
  let inputStr = "";
  if (block.input !== undefined && block.input !== null) {
    try {
      inputStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
    } catch {
      inputStr = String(block.input);
    }
  }
  return inputStr ? `[toolUse: ${name}]\n${inputStr}` : `[toolUse: ${name}]`;
}

function formatToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const blockObject = block as Record<string, unknown>;
      if (blockObject?.type === "text" && typeof blockObject.text === "string") {
        parts.push(blockObject.text.trim());
      }
    }
    return parts.join("\n");
  }
  if (content !== undefined && content !== null) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return "";
}

function extractNewTurnTexts(
  messages: unknown[],
  startIndex: number,
): { texts: string[]; newCount: number } {
  const texts: string[] = [];
  let count = 0;

  for (let index = startIndex; index < messages.length; index += 1) {
    const msg = messages[index] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = msg.role as string;
    if (!role || role === "system") {
      continue;
    }
    count += 1;

    if (role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const resultText = formatToolResultContent(msg.content);
      if (resultText) {
        texts.push(`[${toolName} result]: ${resultText}`);
      }
      continue;
    }

    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      texts.push(`[${role}]: ${content.trim()}`);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        const blockObject = block as Record<string, unknown>;
        if (blockObject?.type === "text" && typeof blockObject.text === "string") {
          texts.push(`[${role}]: ${blockObject.text.trim()}`);
        } else if (blockObject?.type === "toolUse") {
          texts.push(`[${role}]: ${formatToolUseBlock(blockObject)}`);
        }
      }
    }
  }

  return { texts, newCount: count };
}

function extractNewTurnMessages(messages: unknown[], startIndex: number): CapturedTurnMessage[] {
  const captured: CapturedTurnMessage[] = [];

  for (let index = startIndex; index < messages.length; index += 1) {
    const msg = messages[index] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = msg.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = stringifyMessageContent(msg.content);
    if (!content) {
      continue;
    }

    captured.push({
      role,
      content,
    });
  }

  return captured;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    const blockObject = block as Record<string, unknown>;
    if (blockObject?.type === "text" && typeof blockObject.text === "string") {
      const text = blockObject.text.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (blockObject?.type === "toolUse") {
      parts.push(formatToolUseBlock(blockObject));
    }
  }

  return parts.join("\n").trim();
}
