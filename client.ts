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

type CommitSessionOptions = {
  wait?: boolean;
  timeoutMs?: number;
  agentId?: string;
};

type OpenVikingClientOptions = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
};

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: OpenVikingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() ?? "";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async find(
    query: string,
    targetUri: string,
    limit: number,
    scoreThreshold = 0,
    agentId?: string,
  ): Promise<FindResult> {
    return this.request<FindResult>(
      "/api/v1/search/find",
      {
        method: "POST",
        body: JSON.stringify({
          query,
          target_uri: targetUri,
          limit,
          score_threshold: scoreThreshold,
        }),
      },
      agentId,
    );
  }

  async read(uri: string, agentId?: string): Promise<string> {
    return this.request<string>(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      { method: "GET" },
      agentId,
    );
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
    await this.request<void>(
      `/api/v1/fs/delete?uri=${encodeURIComponent(uri)}`,
      { method: "DELETE" },
      agentId,
    );
  }

  private async request<T>(path: string, init: RequestInit, agentId?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) {
        headers.set("X-Api-Key", this.apiKey);
      }

      const effectiveAgentId = agentId?.trim();
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

      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        result?: T;
        error?: { code?: string; message?: string };
      };

      if (!response.ok || payload.status === "error") {
        const code = payload.error?.code ? ` [${payload.error.code}]` : "";
        const message = payload.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OpenViking request failed${code}: ${message}`);
      }

      return (payload.result ?? payload) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
