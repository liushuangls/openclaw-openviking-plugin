import { afterEach, describe, expect, it, vi } from "vitest";

const { definePluginEntryMock } = vi.hoisted(() => ({
  definePluginEntryMock: vi.fn((entry: unknown) => entry),
}));

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: definePluginEntryMock,
}));

const { OpenVikingClient } = await import("../../client.js");
const { default: plugin } = await import("../../index.ts");

type BeforePromptBuildHandler = (
  event: {
    prompt: string;
    messages: unknown[];
  },
  ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
  },
) => Promise<{ prependContext?: string } | void> | { prependContext?: string } | void;

function createPluginApiMock() {
  const handlers = new Map<string, BeforePromptBuildHandler>();
  const api = {
    pluginConfig: {},
    logger: {
      warn: vi.fn(),
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((hookName: string, handler: BeforePromptBuildHandler) => {
      handlers.set(hookName, handler);
    }),
  };

  return {
    api,
    handlers,
  };
}

function createBeforePromptBuildHandler(): BeforePromptBuildHandler {
  const { api, handlers } = createPluginApiMock();
  (plugin as { register(api: unknown): void }).register(api);
  const handler = handlers.get("before_prompt_build");
  expect(handler).toBeDefined();
  return handler!;
}

const REPLIED_MESSAGE_BLOCK = `Replied message (untrusted, for context):
\`\`\`json
{"topic":"quoted bot response","details":"Very long technical context that should not be used as the search query."}
\`\`\``;

describe("before_prompt_build replied message sanitization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("skips recall when the latest user message only contains a replied message block", async () => {
    const getStatusSpy = vi.spyOn(OpenVikingClient.prototype, "getStatus");
    const findSpy = vi.spyOn(OpenVikingClient.prototype, "find");
    const handler = createBeforePromptBuildHandler();

    await expect(
      handler(
        {
          prompt: "",
          messages: [{ role: "user", content: REPLIED_MESSAGE_BLOCK }],
        },
        {},
      ),
    ).resolves.toBeUndefined();

    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("preserves actual user text after a replied message block", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getStatus").mockResolvedValue({});
    const findSpy = vi.spyOn(OpenVikingClient.prototype, "find").mockResolvedValue({});
    const handler = createBeforePromptBuildHandler();
    const query = "Need help with Go channels";

    await expect(
      handler(
        {
          prompt: "",
          messages: [{ role: "user", content: `${REPLIED_MESSAGE_BLOCK}\n\n${query}` }],
        },
        {},
      ),
    ).resolves.toBeUndefined();

    expect(findSpy).toHaveBeenCalledTimes(2);
    expect(findSpy.mock.calls.map(([capturedQuery]) => capturedQuery)).toEqual([query, query]);
  });

  it("leaves messages without replied message blocks unchanged", async () => {
    vi.spyOn(OpenVikingClient.prototype, "getStatus").mockResolvedValue({});
    const findSpy = vi.spyOn(OpenVikingClient.prototype, "find").mockResolvedValue({});
    const handler = createBeforePromptBuildHandler();
    const query = "Remember that I prefer aisle seats";

    await expect(
      handler(
        {
          prompt: "",
          messages: [{ role: "user", content: query }],
        },
        {},
      ),
    ).resolves.toBeUndefined();

    expect(findSpy).toHaveBeenCalledTimes(2);
    expect(findSpy.mock.calls.map(([capturedQuery]) => capturedQuery)).toEqual([query, query]);
  });
});
