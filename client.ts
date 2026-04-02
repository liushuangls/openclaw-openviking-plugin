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

  async commitSession(sessionId: string, agentId?: string): Promise<CommitSessionResult> {
    return this.request<CommitSessionResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
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
