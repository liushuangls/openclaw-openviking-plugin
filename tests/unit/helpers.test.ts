import { describe, expect, it } from "vitest";
import type { FindResultItem } from "../../client.js";
import {
  buildMemoryLinesWithBudget,
  cleanupExpiredPrePromptCounts,
  consumePrePromptCount,
  dedupeMemoriesByUri,
  formatMemoryLines,
  matchesAnyPattern,
  matchesGlobPattern,
  rememberPrePromptCount,
  selectToolMemories,
} from "../../src/helpers.js";

describe("helpers", () => {
  it("dedupes memories by uri across user and agent results", () => {
    const memories: FindResultItem[] = [
      { uri: "viking://user/memories/1", abstract: "Blue", score: 0.9 },
      { uri: "viking://user/memories/1", abstract: "Blue duplicate", score: 0.4 },
      { uri: "viking://agent/memories/2", abstract: "Dark mode", score: 0.8 },
    ];

    expect(dedupeMemoriesByUri(memories)).toEqual([
      { uri: "viking://user/memories/1", abstract: "Blue", score: 0.9 },
      { uri: "viking://agent/memories/2", abstract: "Dark mode", score: 0.8 },
    ]);
  });

  it("filters by score threshold and sorts higher scores first", () => {
    const memories: FindResultItem[] = [
      { uri: "viking://user/memories/1", score: 0.35 },
      { uri: "viking://user/memories/2", score: 0.95 },
      { uri: "viking://user/memories/3", score: 0.6 },
    ];

    expect(
      selectToolMemories(memories, {
        limit: 2,
        scoreThreshold: 0.5,
      }),
    ).toEqual([
      { uri: "viking://user/memories/2", score: 0.95 },
      { uri: "viking://user/memories/3", score: 0.6 },
    ]);
  });

  it("formats memory lines using abstract and overview fallbacks", () => {
    const lines = formatMemoryLines([
      { uri: "viking://user/memories/1", abstract: "Prefers blue", score: 0.91 },
      { uri: "viking://user/memories/2", overview: "Uses dark mode", score: 0.6 },
      { uri: "viking://user/memories/3", score: 0.4 },
    ]);

    expect(lines).toBe(
      "- [91%] viking://user/memories/1: Prefers blue\n" +
        "- [60%] viking://user/memories/2: Uses dark mode\n" +
        "- [40%] viking://user/memories/3",
    );
  });

  it("matches exact glob patterns without wildcards", () => {
    expect(matchesGlobPattern("agent:main:cron:daily", "agent:main:cron:daily")).toBe(
      true,
    );
    expect(matchesGlobPattern("agent:main:cron:daily", "agent:main:cron")).toBe(false);
  });

  it("matches non-colon segments with single star", () => {
    expect(matchesGlobPattern("agent:main:cron", "agent:*:cron")).toBe(true);
  });

  it("does not let single star cross colons", () => {
    expect(matchesGlobPattern("agent:main:cron:daily", "agent:*:daily")).toBe(false);
  });

  it("lets double star match across colon-separated segments", () => {
    expect(matchesGlobPattern("agent:main:cron:daily:run:abc123", "agent:**")).toBe(
      true,
    );
  });

  it("matches real session key examples", () => {
    expect(
      matchesGlobPattern(
        "agent:main:cron:daily:run:abc123",
        "agent:*:cron:**",
      ),
    ).toBe(true);
    expect(
      matchesGlobPattern(
        "agent:main:telegram:direct:5135833757",
        "agent:*:cron:**",
      ),
    ).toBe(false);
    expect(
      matchesGlobPattern(
        "agent:main:telegram:direct:5135833757",
        "agent:*:telegram:direct:**",
      ),
    ).toBe(true);
  });

  it("matches when any pattern matches", () => {
    expect(
      matchesAnyPattern("agent:main:telegram:direct:5135833757", [
        "agent:*:cron:**",
        "agent:*:telegram:direct:**",
      ]),
    ).toBe(true);
  });

  it("returns false for empty pattern arrays", () => {
    expect(matchesAnyPattern("agent:main:cron:daily", [])).toBe(false);
  });

  it("builds memory lines within the token budget", async () => {
    const result = await buildMemoryLinesWithBudget(
      [
        {
          uri: "viking://user/memories/1",
          category: "preferences",
          level: 2,
          abstract: "Short summary",
        },
        {
          uri: "viking://user/memories/2",
          category: "memory",
          level: 2,
          abstract: "Second summary",
        },
      ],
      async (uri) => `${uri} full content`,
      {
        recallPreferAbstract: false,
        recallMaxContentChars: 24,
        recallTokenBudget: 10,
      },
    );

    expect(result.lines).toEqual(["- [preferences] viking://user/memories/1..."]);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("cleans up expired prePromptCounts and consumes active entries", () => {
    const store = new Map();

    rememberPrePromptCount(store, "fresh", 3, 1_000);
    rememberPrePromptCount(store, "stale", 9, 100);
    rememberPrePromptCount(store, "fresh", 99, 2_000);

    expect(cleanupExpiredPrePromptCounts(store, 500, 1_001)).toBe(1);
    expect(consumePrePromptCount(store, "fresh")).toBe(3);
    expect(consumePrePromptCount(store, "stale")).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
