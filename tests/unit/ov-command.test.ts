import { afterEach, describe, expect, it, vi } from "vitest";

const { definePluginEntryMock } = vi.hoisted(() => ({
  definePluginEntryMock: vi.fn((entry: unknown) => entry),
}));

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: definePluginEntryMock,
}));

const { OpenVikingClient } = await import("../../client.js");
const { default: plugin } = await import("../../index.ts");

type CommandHandler = (ctx: {
  args?: string;
  channel: string;
  commandBody: string;
  config: Record<string, unknown>;
  isAuthorizedSender: boolean;
  sessionKey?: string;
  requestConversationBinding: () => Promise<unknown>;
  detachConversationBinding: () => Promise<unknown>;
  getCurrentConversationBinding: () => Promise<unknown>;
}) => Promise<{ text: string }> | { text: string };

type RegisteredCommand = {
  name: string;
  nativeNames?: { default?: string };
  description: string;
  acceptsArgs?: boolean;
  handler: CommandHandler;
};

function createPluginApiMock(pluginConfig: Record<string, unknown> = {}) {
  let registeredCommand: RegisteredCommand | undefined;

  const api = {
    pluginConfig,
    logger: {
      warn: vi.fn(),
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn((command: RegisteredCommand) => {
      registeredCommand = command;
    }),
    on: vi.fn(),
  };

  return {
    api,
    getCommand() {
      return registeredCommand;
    },
  };
}

function createBaseCommandContext(overrides: Partial<Parameters<CommandHandler>[0]> = {}) {
  return {
    channel: "telegram",
    commandBody: "/ov",
    config: {},
    isAuthorizedSender: true,
    requestConversationBinding: async () => null,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function registerCommand(pluginConfig: Record<string, unknown> = {}) {
  const { api, getCommand } = createPluginApiMock(pluginConfig);
  (plugin as { register(api: unknown): void }).register(api);
  const command = getCommand();
  expect(command).toBeDefined();
  return command!;
}

describe("/ov command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("shows plugin, config, server, and memory status when OV is online", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getStatus").mockResolvedValue({
      user: "default",
      version: "0.9.1",
    });
    vi.spyOn(OpenVikingClient.prototype, "ls")
      .mockResolvedValueOnce([{ name: "u1" }, { name: "u2" }])
      .mockResolvedValueOnce([
        { name: "a1" },
        { name: "a2" },
        { name: "a3" },
      ]);

    const command = registerCommand({
      baseUrl: "http://ov.example",
      autoRecall: false,
      autoCapture: true,
      captureSessionFilter: ["agent:*:telegram:direct:**"],
      recallLimit: 9,
      recallScoreThreshold: 0.42,
      recallTokenBudget: 4096,
      recallMaxContentChars: 777,
      commitTokenThreshold: 8888,
    });

    const result = await command.handler(
      createBaseCommandContext({
        args: "status",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );

    expect(result.text).toContain("🦞 OpenViking Plugin v0.1.3");
    expect(result.text).toContain("Help: /openviking help · Alias: /ov");
    expect(result.text).toContain("autoRecall: no");
    expect(result.text).toContain("autoCapture: yes");
    expect(result.text).toContain("captureSessionFilter: agent:*:telegram:direct:**");
    expect(result.text).toContain("baseUrl: http://ov.example");
    expect(result.text).toContain("recallLimit: 9");
    expect(result.text).toContain("recallScoreThreshold: 0.42");
    expect(result.text).toContain("recallTokenBudget: 4096");
    expect(result.text).toContain("recallMaxContentChars: 777");
    expect(result.text).toContain("commitTokenThreshold: 8888");
    expect(result.text).toContain("status: online");
    expect(result.text).toContain("version: 0.9.1");
    expect(result.text).toContain("user: 2 items");
    expect(result.text).toContain("agent: 3 items");
  });

  it("shows offline server status and unavailable memory counts when OV calls fail", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getStatus").mockRejectedValue(new Error("offline"));
    vi.spyOn(OpenVikingClient.prototype, "ls").mockRejectedValue(new Error("offline"));

    const command = registerCommand();
    const result = await command.handler(createBaseCommandContext());

    expect(result.text).toContain("status: offline");
    expect(result.text).toContain("version: unknown");
    expect(result.text).toContain("user: unavailable");
    expect(result.text).toContain("agent: unavailable");
  });

  it("shows help without calling OV", async () => {
    const getStatusSpy = vi.spyOn(OpenVikingClient.prototype, "getStatus");
    const lsSpy = vi.spyOn(OpenVikingClient.prototype, "ls");

    const command = registerCommand();
    const result = await command.handler(
      createBaseCommandContext({
        args: "help",
        commandBody: "/ov help",
      }),
    );

    expect(result.text).toContain("🦞 OpenViking Plugin v0.1.3");
    expect(result.text).toContain("Commands");
    expect(result.text).toContain("status: Show plugin status and diagnostics");
    expect(result.text).toContain("help: Show this help");
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(lsSpy).not.toHaveBeenCalled();
  });
});
