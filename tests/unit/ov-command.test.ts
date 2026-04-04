import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { definePluginEntryMock, execSyncMock } = vi.hoisted(() => ({
  definePluginEntryMock: vi.fn((entry: unknown) => entry),
  execSyncMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: definePluginEntryMock,
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

const { OpenVikingClient } = await import("../../client.js");
const { default: plugin } = await import("../../index.ts");
const { version: pluginVersion } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

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
    execSyncMock.mockReset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("shows plugin, config, server, and memory status when OV is online", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getHealth").mockResolvedValue({
      healthy: true,
      version: "v0.3.1",
    });
    vi.spyOn(OpenVikingClient.prototype, "ls").mockImplementation((uri: string) => {
      const responses: Record<string, Array<Record<string, unknown>>> = {
        "viking://user/memories": [
          { name: "entities", isDir: true },
          { name: "events", isDir: true },
        ],
        "viking://user/memories/entities": [{ name: "u1" }],
        "viking://user/memories/events": [{ name: "u2" }],
        "viking://agent/memories": [
          { name: "cases", isDir: true },
          { name: "patterns", isDir: true },
        ],
        "viking://agent/memories/cases": [{ name: "a1" }, { name: "a2" }],
        "viking://agent/memories/patterns": [{ name: "a3" }],
      };
      return Promise.resolve(responses[uri] ?? []);
    });

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

    expect(result.text).toContain(`🦞 OpenViking Plugin v${pluginVersion}`);
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
    expect(result.text).toContain("version: v0.3.1");
    expect(result.text).toContain("user:");
    expect(result.text).toContain("  entities: 1");
    expect(result.text).toContain("  events: 1");
    expect(result.text).toContain("agent:");
    expect(result.text).toContain("  cases: 2");
    expect(result.text).toContain("  patterns: 1");
  });

  it("shows version n/a when OV health does not provide it", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getHealth").mockResolvedValue({
      healthy: true,
    });
    vi.spyOn(OpenVikingClient.prototype, "ls").mockRejectedValue(new Error("missing"));

    const command = registerCommand();
    const result = await command.handler(createBaseCommandContext());

    expect(result.text).toContain("status: online");
    expect(result.text).toContain("version: n/a");
  });

  it("shows offline server status and unavailable memory counts when OV calls fail", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getHealth").mockRejectedValue(new Error("offline"));
    vi.spyOn(OpenVikingClient.prototype, "ls").mockRejectedValue(new Error("offline"));

    const command = registerCommand();
    const result = await command.handler(createBaseCommandContext());

    expect(result.text).toContain("status: offline");
    expect(result.text).toContain("version: n/a");
    expect(result.text).toContain("user:\n  unavailable");
    expect(result.text).toContain("agent:\n  unavailable");
  });

  it("shows queue section when OV is local", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getHealth").mockResolvedValue({
      healthy: true,
      version: "v0.3.1",
    });
    vi.spyOn(OpenVikingClient.prototype, "ls").mockImplementation((uri: string) => {
      const responses: Record<string, Array<Record<string, unknown>>> = {
        "viking://user/memories": [{ name: "entities", isDir: true }],
        "viking://user/memories/entities": [{ name: "u1" }],
        "viking://agent/memories": [{ name: "cases", isDir: true }],
        "viking://agent/memories/cases": [{ name: "a1" }],
      };
      return Promise.resolve(responses[uri] ?? []);
    });
    execSyncMock.mockReturnValue("pending|144\nprocessing|2");

    const command = registerCommand({
      baseUrl: "http://127.0.0.1:1933",
    });
    const result = await command.handler(createBaseCommandContext());

    expect(result.text).toContain("📬 Queue");
    expect(result.text).toContain("pending: 144");
    expect(result.text).toContain("processing: 2");
    expect(execSyncMock).toHaveBeenCalledWith(
      'sqlite3 "/home/liushuang/docker/openviking/data/_system/queue/queue.db" "SELECT status, count(*) FROM queue_messages GROUP BY status;"',
      { encoding: "utf8" },
    );
  });

  it("shows help without calling OV", async () => {
    const getHealthSpy = vi.spyOn(OpenVikingClient.prototype, "getHealth");
    const lsSpy = vi.spyOn(OpenVikingClient.prototype, "ls");

    const command = registerCommand();
    const result = await command.handler(
      createBaseCommandContext({
        args: "help",
        commandBody: "/ov help",
      }),
    );

    expect(result.text).toContain(`🦞 OpenViking Plugin v${pluginVersion}`);
    expect(result.text).toContain("Commands");
    expect(result.text).toContain("status: Show plugin status and diagnostics");
    expect(result.text).toContain("help: Show this help");
    expect(getHealthSpy).not.toHaveBeenCalled();
    expect(lsSpy).not.toHaveBeenCalled();
  });
});
