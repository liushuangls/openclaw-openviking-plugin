import { mkdtempSync } from "node:fs";
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

function createAgentEndHandler(pluginConfig: Record<string, unknown> = {}) {
  const { api, handlers } = createPluginApiMock(pluginConfig);
  (plugin as { register(api: unknown): void }).register(api);
  const handler = handlers.get("agent_end");
  expect(handler).toBeDefined();
  return handler as AgentEndHandler;
}

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "ov-plugin-home-"));
}

async function runAgentEndCapture(content: string) {
  const addSessionMessageSpy = vi
    .spyOn(OpenVikingClient.prototype, "addSessionMessage")
    .mockResolvedValue(undefined);
  const commitSessionSpy = vi
    .spyOn(OpenVikingClient.prototype, "commitSession")
    .mockResolvedValue({ session_id: "session-1", status: "accepted" } as never);
  const handler = createAgentEndHandler({
    commitTokenThreshold: 100_000,
  });

  await handler(
    {
      messages: [{ role: "user", content }],
    },
    {
      agentId: "agent-1",
      sessionId: "session-1",
    },
  );

  return {
    addSessionMessageSpy,
    commitSessionSpy,
  };
}

describe("agent_end autoCapture sanitization", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("filters heartbeat prompt blocks before autoCapture", async () => {
    process.env.HOME = createTempHome();
    const { addSessionMessageSpy, commitSessionSpy } = await runAgentEndCapture(`Read HEARTBEAT.md if it exists
Check whether HEARTBEAT.md has pending tasks.
If there are none, reply HEARTBEAT_OK.

Remember that I prefer spicy food.`);

    expect(addSessionMessageSpy).toHaveBeenCalledTimes(1);
    expect(addSessionMessageSpy).toHaveBeenCalledWith(
      "session-1",
      "user",
      "Remember that I prefer spicy food.",
      "agent-1",
    );
    expect(commitSessionSpy).not.toHaveBeenCalled();
  });

  it("skips autoCapture when the message only contains HEARTBEAT_OK", async () => {
    process.env.HOME = createTempHome();
    const { addSessionMessageSpy, commitSessionSpy } = await runAgentEndCapture("HEARTBEAT_OK");

    expect(addSessionMessageSpy).not.toHaveBeenCalled();
    expect(commitSessionSpy).not.toHaveBeenCalled();
  });

  it("filters system event lines before autoCapture", async () => {
    process.env.HOME = createTempHome();
    const { addSessionMessageSpy, commitSessionSpy } = await runAgentEndCapture(`System: Running tests
[System: Background sync finished]
Remember that I prefer aisle seats.`);

    expect(addSessionMessageSpy).toHaveBeenCalledTimes(1);
    expect(addSessionMessageSpy).toHaveBeenCalledWith(
      "session-1",
      "user",
      "Remember that I prefer aisle seats.",
      "agent-1",
    );
    expect(commitSessionSpy).not.toHaveBeenCalled();
  });
});
