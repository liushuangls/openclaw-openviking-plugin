import { describe, expect, it, vi } from "vitest";
import { matchesAnyPattern } from "../../src/helpers.js";

async function runAgentEndCaptureFilter(options: {
  sessionKey?: string;
  captureSessionFilter: string[];
  addSessionMessage: (
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    agentId?: string,
  ) => Promise<void>;
}): Promise<boolean> {
  const { sessionKey, captureSessionFilter, addSessionMessage } = options;

  if (captureSessionFilter.length > 0) {
    const key = sessionKey ?? "";
    if (!matchesAnyPattern(key, captureSessionFilter)) {
      return false;
    }
  }

  await addSessionMessage("session-1", "user", "Remember this message", "agent-1");
  return true;
}

describe("agent_end captureSessionFilter", () => {
  it("captures for any sessionKey when captureSessionFilter is empty", async () => {
    const addSessionMessage = vi.fn().mockResolvedValue(undefined);

    const captured = await runAgentEndCaptureFilter({
      sessionKey: "agent:main:cron:daily:run:abc",
      captureSessionFilter: [],
      addSessionMessage,
    });

    expect(captured).toBe(true);
    expect(addSessionMessage).toHaveBeenCalledTimes(1);
  });

  it("captures when the sessionKey matches the configured filter", async () => {
    const addSessionMessage = vi.fn().mockResolvedValue(undefined);

    const captured = await runAgentEndCaptureFilter({
      sessionKey: "agent:main:telegram:direct:5135833757",
      captureSessionFilter: ["agent:*:telegram:direct:**"],
      addSessionMessage,
    });

    expect(captured).toBe(true);
    expect(addSessionMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    "",
    "agent:main:cron:daily:run:abc",
  ])("skips capture when the sessionKey does not match: %s", async (sessionKey) => {
    const addSessionMessage = vi.fn().mockResolvedValue(undefined);

    const captured = await runAgentEndCaptureFilter({
      sessionKey,
      captureSessionFilter: ["agent:*:telegram:direct:**"],
      addSessionMessage,
    });

    expect(captured).toBe(false);
    expect(addSessionMessage).not.toHaveBeenCalled();
  });

  it("captures when any pattern matches among multiple configured filters", async () => {
    const addSessionMessage = vi.fn().mockResolvedValue(undefined);

    const captured = await runAgentEndCaptureFilter({
      sessionKey: "agent:main:telegram:direct:5135833757",
      captureSessionFilter: [
        "agent:*:cron:**",
        "agent:*:telegram:direct:**",
        "agent:*:webhook:**",
      ],
      addSessionMessage,
    });

    expect(captured).toBe(true);
    expect(addSessionMessage).toHaveBeenCalledTimes(1);
  });
});
