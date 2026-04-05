import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { definePluginEntryMock } = vi.hoisted(() => ({
  definePluginEntryMock: vi.fn((entry: unknown) => entry),
}));

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: definePluginEntryMock,
}));

const { OpenVikingClient } = await import("../../client.js");
const { default: plugin } = await import("../../index.ts");

type AgentEndHandler = (
  event: {
    messages: unknown[];
  },
  ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
  },
) => Promise<void> | void;

function createPluginApiMock(pluginConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, unknown>();
  const api = {
    pluginConfig,
    logger: {
      warn: vi.fn(),
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((hookName: string, handler: unknown) => {
      handlers.set(hookName, handler);
    }),
  };

  return {
    api,
    handlers,
  };
}

function createAgentEndHandler(pluginConfig: Record<string, unknown> = {}): AgentEndHandler {
  const { api, handlers } = createPluginApiMock(pluginConfig);
  (plugin as { register(api: unknown): void }).register(api);
  const handler = handlers.get("agent_end");
  expect(handler).toBeDefined();
  return handler as AgentEndHandler;
}

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "ov-plugin-home-"));
}

function getCaptureStatePath(homeDir: string): string {
  return join(
    homeDir,
    ".openclaw",
    "extensions",
    "openclaw-openviking-plugin",
    "capture-state.json",
  );
}

describe("agent_end autoCapture accumulation", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("accumulates tokens across turns, commits at the threshold, and resets persisted state", async () => {
    const tempHome = createTempHome();
    process.env.HOME = tempHome;

    const addSessionMessageSpy = vi
      .spyOn(OpenVikingClient.prototype, "addSessionMessage")
      .mockResolvedValue(undefined);
    const commitSessionSpy = vi
      .spyOn(OpenVikingClient.prototype, "commitSession")
      .mockResolvedValue({ session_id: "session-1", status: "accepted" } as never);
    const handler = createAgentEndHandler({
      commitTokenThreshold: 10,
    });

    const ctx = {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
    };
    const event = {
      messages: [{ role: "user", content: "Remember that I like ramen." }],
    };

    await handler(event, ctx);
    await handler(event, ctx);
    await handler(event, ctx);
    await handler(event, ctx);

    expect(addSessionMessageSpy).toHaveBeenCalledTimes(4);
    expect(commitSessionSpy).toHaveBeenCalledTimes(2);
    expect(commitSessionSpy).toHaveBeenNthCalledWith(1, "session-1", "agent-1");
    expect(commitSessionSpy).toHaveBeenNthCalledWith(2, "session-1", "agent-1");

    const persisted = JSON.parse(readFileSync(getCaptureStatePath(tempHome), "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted).toMatchObject({
      __meta: {
        commits: 2,
      },
      "session-1": {
        accumulatedTokens: 0,
        sessionKey: "agent:main:telegram:direct:123",
      },
    });
  });
});
