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
  const warn = vi.fn();
  const api = {
    pluginConfig: {},
    logger: {
      warn,
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
    warn,
  };
}

describe("before_prompt_build autoRecall timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("skips recall when OV precheck exceeds the short timeout", async () => {
    vi.useFakeTimers();

    const statusSpy = vi
      .spyOn(OpenVikingClient.prototype, "getStatus")
      .mockImplementation(() => new Promise<never>(() => {}));
    const findSpy = vi.spyOn(OpenVikingClient.prototype, "find").mockResolvedValue({});
    const { api, handlers, warn } = createPluginApiMock();

    (plugin as { register(api: unknown): void }).register(api);

    const handler = handlers.get("before_prompt_build");
    expect(handler).toBeDefined();

    const hookPromise = Promise.resolve(
      handler!(
        {
          prompt: "Remember that I prefer aisle seats.",
          messages: [{ role: "user", content: "Remember that I prefer aisle seats." }],
        },
        {},
      ),
    );
    const settled = vi.fn();
    void hookPromise.then(settled);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).not.toHaveBeenCalled();
    expect(findSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(hookPromise).resolves.toBeUndefined();

    expect(settled).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "openclaw-openviking-plugin: OV unreachable, skipping autoRecall",
    );
  });

  it("returns without throwing when recall exceeds the total timeout", async () => {
    vi.useFakeTimers();

    vi.spyOn(OpenVikingClient.prototype, "getStatus").mockResolvedValue({});
    const findSpy = vi
      .spyOn(OpenVikingClient.prototype, "find")
      .mockImplementation(() => new Promise<never>(() => {}));
    const { api, handlers, warn } = createPluginApiMock();

    (plugin as { register(api: unknown): void }).register(api);

    const handler = handlers.get("before_prompt_build");
    expect(handler).toBeDefined();

    const hookPromise = Promise.resolve(
      handler!(
        {
          prompt: "Remember that I prefer aisle seats.",
          messages: [{ role: "user", content: "Remember that I prefer aisle seats." }],
        },
        {},
      ),
    );
    const settled = vi.fn();
    void hookPromise.then(settled);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(hookPromise).resolves.toBeUndefined();

    expect(settled).toHaveBeenCalledTimes(1);
    expect(findSpy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "openclaw-openviking-plugin: autoRecall timed out, skipping",
    );
  });
});
