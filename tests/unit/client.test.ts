import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenVikingClient, OpenVikingRequestError } from "../../client.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(body == null ? null : JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status: 200,
    ...init,
  });
}

function getHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe("OpenVikingClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("find() sends the expected POST request and returns memories", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            user: "default",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ name: "default", isDir: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            memories: [{ uri: "viking://user/default/memories/1", abstract: "Blue", score: 0.91 }],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({
      baseUrl: "http://ov.example/",
      apiKey: "secret-key",
    });

    const result = await client.find(
      "favorite color",
      "viking://user/memories",
      5,
      0.25,
      "agent-1",
    );

    expect(result.memories).toEqual([
      { uri: "viking://user/default/memories/1", abstract: "Blue", score: 0.91 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [statusUrl, statusInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(statusUrl).toBe("http://ov.example/api/v1/system/status");
    expect(statusInit.method).toBe("GET");
    expect(getHeaders(statusInit).get("X-OpenViking-Agent")).toBe("agent-1");

    const [lsUrl, lsInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(lsUrl).toBe("http://ov.example/api/v1/fs/ls?uri=viking%3A%2F%2Fuser&output=original");
    expect(lsInit.method).toBe("GET");
    expect(getHeaders(lsInit).get("X-OpenViking-Agent")).toBe("agent-1");

    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("http://ov.example/api/v1/search/find");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "favorite color",
      target_uris: ["viking://user/default/memories"],
      limit: 5,
      score_threshold: 0.25,
    });

    const headers = getHeaders(init);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Api-Key")).toBe("secret-key");
    expect(headers.get("X-OpenViking-Agent")).toBe("agent-1");
  });

  it("read() returns an empty string on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: "error",
          error: {
            code: "not_found",
            message: "missing",
          },
        },
        { status: 404, statusText: "Not Found" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example" });

    await expect(client.read("viking://user/memories/missing")).resolves.toBe("");
  });

  it("addSessionMessage() posts to the session messages endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        result: {
          session_id: "session-1",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example" });

    await client.addSessionMessage("session-1", "user", "Hello memory", "agent-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ov.example/api/v1/sessions/session-1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      role: "user",
      content: "Hello memory",
    });
    expect(getHeaders(init).get("X-OpenViking-Agent")).toBe("agent-1");
  });

  it("commitSession() without wait is fire-and-forget", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        result: {
          session_id: "session-1",
          status: "accepted",
          task_id: "task-1",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example" });

    const result = await client.commitSession("session-1", { agentId: "agent-1" });

    expect(result).toEqual({
      session_id: "session-1",
      status: "accepted",
      task_id: "task-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ov.example/api/v1/sessions/session-1/commit");
  });

  it("commitSession({ wait: true }) polls task status until completed", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            session_id: "session-1",
            status: "accepted",
            task_id: "task-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            status: "running",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            status: "completed",
            result: {
              memories_extracted: {
                user: 1,
                agent: 2,
              },
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({
      baseUrl: "http://ov.example",
      timeoutMs: 60_000,
    });

    const pending = client.commitSession("session-1", {
      wait: true,
      timeoutMs: 2_000,
      agentId: "agent-1",
    });

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toEqual({
      session_id: "session-1",
      status: "completed",
      task_id: "task-1",
      memories_extracted: {
        user: 1,
        agent: 2,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://ov.example/api/v1/tasks/task-1");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://ov.example/api/v1/tasks/task-1");
  });

  it("delete() sends a DELETE request with the encoded uri", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example" });

    await client.delete("viking://user/memories/hello world", "agent-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://ov.example/api/v1/fs/delete?uri=viking%3A%2F%2Fuser%2Fmemories%2Fhello%20world",
    );
    expect(init.method).toBe("DELETE");
    expect(getHeaders(init).get("X-OpenViking-Agent")).toBe("agent-1");
  });

  it("delete() treats a 404 as an idempotent delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: "error",
          error: {
            code: "not_found",
            message: "missing",
          },
        },
        { status: 404, statusText: "Not Found" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example" });

    await expect(client.delete("viking://user/memories/missing")).resolves.toBeUndefined();
  });

  it("throws OpenVikingRequestError with status information for non-2xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: "error",
          error: {
            code: "bad_request",
            message: "broken request",
          },
        },
        { status: 500, statusText: "Internal Server Error" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example" });

    try {
      await client.delete("viking://user/memories/bad");
      throw new Error("expected delete() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenVikingRequestError);
      expect((error as OpenVikingRequestError).status).toBe(500);
      expect((error as OpenVikingRequestError).code).toBe("bad_request");
      expect(String(error)).toContain("status 500");
      expect(String(error)).toContain("bad_request");
    }
  });

  it("omits the apiKey header when apiKey is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: { memories: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenVikingClient({ baseUrl: "http://ov.example", apiKey: "   " });

    await client.find("query", "viking://user/default/memories", 3, 0);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getHeaders(init).has("X-Api-Key")).toBe(false);
  });
});
