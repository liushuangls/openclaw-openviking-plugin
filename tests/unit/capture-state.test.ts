import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureStateStore } from "../../src/capture-state.ts";

function createStateFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ov-plugin-capture-state-"));
  return join(dir, "capture-state.json");
}

describe("CaptureStateStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists debounced token updates and reloads them from disk", async () => {
    vi.useFakeTimers();

    const stateFilePath = createStateFilePath();
    const sessionKey = "agent:main:telegram:direct:123";
    const store = new CaptureStateStore({
      stateFilePath,
      debounceMs: 5_000,
    });

    expect(store.getAccumulatedTokens({ sessionKey })).toBe(0);

    store.recordTokens("session-1", 6, sessionKey);
    store.recordTokens("session-1", 4, sessionKey);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(() => readFileSync(stateFilePath, "utf8")).toThrow();

    await vi.advanceTimersByTimeAsync(1);

    const persisted = JSON.parse(readFileSync(stateFilePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      __meta: {
        commits: 0,
      },
      "session-1": {
        accumulatedTokens: 10,
        sessionKey,
      },
    });

    const reloadedStore = new CaptureStateStore({
      stateFilePath,
      debounceMs: 5_000,
    });
    expect(reloadedStore.getAccumulatedTokens({ sessionKey })).toBe(10);
    expect(reloadedStore.getCommitCount()).toBe(0);

    reloadedStore.recordCommit("session-1", sessionKey);

    const afterCommit = JSON.parse(readFileSync(stateFilePath, "utf8")) as Record<string, unknown>;
    expect(afterCommit).toMatchObject({
      __meta: {
        commits: 1,
      },
      "session-1": {
        accumulatedTokens: 0,
        sessionKey,
      },
    });
  });
});
