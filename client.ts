import { createHash } from "node:crypto";

export type FindResultItem = {
  uri: string;
  level?: number;
  abstract?: string;
  overview?: string;
  category?: string;
  score?: number;
  match_reason?: string;
};

export type FindResult = {
  memories?: FindResultItem[];
  resources?: FindResultItem[];
  skills?: FindResultItem[];
  total?: number;
};

export type CommitSessionResult = {
  session_id: string;
  status: string;
  task_id?: string;
  archive_uri?: string;
  archived?: boolean;
  memories_extracted?: Record<string, number>;
  error?: string;
};

export type TaskResult = {
  status: string;
  result?: unknown;
  error?: string;
};

export type SystemStatusResult = {
  user?: unknown;
};

type ScopeName = "user" | "agent";
type RuntimeIdentity = { userId: string; agentId: string };

export class OpenVikingRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(
      `OpenViking request failed (status ${status}${code ? `, code ${code}` : ""}): ${message}`,
    );
    this.name = "OpenVikingRequestError";
    this.status = status;
    this.code = code;
  }
}

type CommitSessionOptions = {
  wait?: boolean;
  timeoutMs?: number;
  agentId?: string;
};

type OpenVikingClientOptions = {
  baseUrl: string;
  apiKey?: string;
  agentId?: string;
  timeoutMs?: number;
};

const USER_STRUCTURE_DIRS = new Set(["memories"]);
const AGENT_STRUCTURE_DIRS = new Set(["memories", "skills", "instructions", "workspaces"]);

function md5Short(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 12);
}

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultAgentId: string;
  private readonly timeoutMs: number;
  private spaceCache = new Map<string, Partial<Record<ScopeName, string>>>();
  private identityCache = new Map<string, RuntimeIdentity>();

  constructor(options: OpenVikingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() ?? "";
    this.defaultAgentId = options.agentId?.trim() ?? "";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async find(
    query: string,
    targetUri: string,
    limit: number,
    scoreThreshold = 0,
    agentId?: string,
  ): Promise<FindResult> {
    const normalizedUri = await this.normalizeTargetUri(targetUri, agentId);

    return this.request<FindResult>(
      "/api/v1/search/find",
      {
        method: "POST",
        body: JSON.stringify({
          query,
          target_uris: [normalizedUri],
          limit,
          score_threshold: scoreThreshold,
        }),
      },
      agentId,
    );
  }

  async getStatus(agentId?: string): Promise<SystemStatusResult> {
    return this.request<SystemStatusResult>(
      "/api/v1/system/status",
      { method: "GET" },
      agentId,
    );
  }

  private async ls(uri: string, agentId?: string): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(
      `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}&output=original`,
      { method: "GET" },
      agentId,
    );
  }

  private async getRuntimeIdentity(agentId?: string): Promise<RuntimeIdentity> {
    const effectiveAgentId = agentId?.trim() || this.defaultAgentId;
    const cached = this.identityCache.get(effectiveAgentId);
    if (cached) {
      return cached;
    }

    const fallback: RuntimeIdentity = {
      userId: "default",
      agentId: effectiveAgentId || "default",
    };

    try {
      const status = await this.getStatus(agentId);
      const userId =
        typeof status.user === "string" && status.user.trim() ? status.user.trim() : "default";
      const identity: RuntimeIdentity = { userId, agentId: effectiveAgentId || "default" };
      this.identityCache.set(effectiveAgentId, identity);
      return identity;
    } catch {
      this.identityCache.set(effectiveAgentId, fallback);
      return fallback;
    }
  }

  private async resolveScopeSpace(scope: ScopeName, agentId?: string): Promise<string> {
    const effectiveAgentId = agentId?.trim() || this.defaultAgentId;
    const agentScopes = this.spaceCache.get(effectiveAgentId);
    const cached = agentScopes?.[scope];
    if (cached) {
      return cached;
    }

    const identity = await this.getRuntimeIdentity(agentId);
    const fallbackSpace =
      scope === "user" ? identity.userId : md5Short(`${identity.userId}:${identity.agentId}`);
    const reservedDirs = scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    const preferredSpace =
      scope === "user" ? identity.userId : md5Short(`${identity.userId}:${identity.agentId}`);

    const saveSpace = (space: string) => {
      const existing = this.spaceCache.get(effectiveAgentId) ?? {};
      existing[scope] = space;
      this.spaceCache.set(effectiveAgentId, existing);
    };

    try {
      const entries = await this.ls(`viking://${scope}`, agentId);
      const spaces = entries
        .filter((entry) => entry?.isDir === true)
        .map((entry) => (typeof entry.name === "string" ? entry.name.trim() : ""))
        .filter((name) => name && !name.startsWith(".") && !reservedDirs.has(name));

      if (spaces.length > 0) {
        if (spaces.includes(preferredSpace)) {
          saveSpace(preferredSpace);
          return preferredSpace;
        }
        if (scope === "user" && spaces.includes("default")) {
          saveSpace("default");
          return "default";
        }
        if (spaces.length === 1) {
          saveSpace(spaces[0]!);
          return spaces[0]!;
        }
      }
    } catch {
      // Fall back to identity-derived space when listing fails.
    }

    saveSpace(fallbackSpace);
    return fallbackSpace;
  }

  private async normalizeTargetUri(targetUri: string, agentId?: string): Promise<string> {
    const trimmed = targetUri.trim().replace(/\/+$/, "");
    const match = trimmed.match(/^viking:\/\/(user|agent)(?:\/(.*))?$/);
    if (!match) {
      return trimmed;
    }

    const scope = match[1] as ScopeName;
    const rawRest = (match[2] ?? "").trim();
    if (!rawRest) {
      return trimmed;
    }

    const parts = rawRest.split("/").filter(Boolean);
    if (parts.length === 0) {
      return trimmed;
    }

    const reservedDirs = scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    if (!reservedDirs.has(parts[0]!)) {
      return trimmed;
    }

    const space = await this.resolveScopeSpace(scope, agentId);
    return `viking://${scope}/${space}/${parts.join("/")}`;
  }

  async read(uri: string, agentId?: string): Promise<string> {
    try {
      return await this.request<string>(
        `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
        { method: "GET" },
        agentId,
      );
    } catch (error) {
      if (error instanceof OpenVikingRequestError && error.status === 404) {
        return "";
      }
      throw error;
    }
  }

  async addSessionMessage(
    sessionId: string,
    role: string,
    content: string,
    agentId?: string,
  ): Promise<void> {
    await this.request<{ session_id: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      },
      agentId,
    );
  }

  async commitSession(
    sessionId: string,
    optionsOrAgentId?: string | CommitSessionOptions,
  ): Promise<CommitSessionResult> {
    const options: CommitSessionOptions =
      typeof optionsOrAgentId === "string"
        ? { agentId: optionsOrAgentId }
        : (optionsOrAgentId ?? {});

    const result = await this.request<CommitSessionResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      options.agentId,
    );

    if (!options.wait || !result.task_id) {
      return result;
    }

    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      await sleep(500);
      const task = await this.getTask(result.task_id, options.agentId).catch(() => null);
      if (!task) {
        break;
      }
      if (task.status === "completed") {
        const taskResult =
          task.result && typeof task.result === "object"
            ? (task.result as Record<string, unknown>)
            : {};
        result.status = "completed";
        result.memories_extracted = (taskResult.memories_extracted ??
          {}) as Record<string, number>;
        return result;
      }
      if (task.status === "failed") {
        result.status = "failed";
        result.error = task.error;
        return result;
      }
    }

    result.status = "timeout";
    return result;
  }

  async getTask(taskId: string, agentId?: string): Promise<TaskResult> {
    return this.request<TaskResult>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET" },
      agentId,
    );
  }

  async delete(uri: string, agentId?: string): Promise<void> {
    try {
      await this.request<void>(
        `/api/v1/fs/delete?uri=${encodeURIComponent(uri)}`,
        { method: "DELETE" },
        agentId,
      );
    } catch (error) {
      if (error instanceof OpenVikingRequestError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit, agentId?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) {
        headers.set("X-Api-Key", this.apiKey);
      }

      const effectiveAgentId = agentId?.trim() || this.defaultAgentId;
      if (effectiveAgentId) {
        headers.set("X-OpenViking-Agent", effectiveAgentId);
      }

      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => undefined)) as
        | {
            status?: string;
            result?: T;
            error?: { code?: string; message?: string };
          }
        | undefined;

      if (!response.ok || payload?.status === "error") {
        const code = payload?.error?.code;
        const message =
          payload?.error?.message ??
          response.statusText ??
          `HTTP ${response.status}`;
        throw new OpenVikingRequestError(response.status, message, code);
      }

      return (payload?.result ?? payload) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
