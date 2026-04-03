import type { FindResultItem } from "../client.js";

export type BuildMemoryLinesOptions = {
  recallPreferAbstract: boolean;
  recallMaxContentChars: number;
  recallTokenBudget: number;
};

export type PrePromptCountEntry = {
  count: number;
  updatedAt: number;
};

export function rememberPrePromptCount(
  store: Map<string, PrePromptCountEntry>,
  sessionId: string,
  count: number,
  now = Date.now(),
): void {
  if (!sessionId || store.has(sessionId)) {
    return;
  }

  store.set(sessionId, {
    count,
    updatedAt: now,
  });
}

export function consumePrePromptCount(
  store: Map<string, PrePromptCountEntry>,
  sessionId: string,
): number | undefined {
  const entry = store.get(sessionId);
  if (!entry) {
    return undefined;
  }

  store.delete(sessionId);
  return entry.count;
}

export function cleanupExpiredPrePromptCounts(
  store: Map<string, PrePromptCountEntry>,
  ttlMs: number,
  now = Date.now(),
): number {
  let removed = 0;

  for (const [sessionId, entry] of store.entries()) {
    if (now - entry.updatedAt < ttlMs) {
      continue;
    }

    store.delete(sessionId);
    removed += 1;
  }

  return removed;
}

export function dedupeMemoriesByUri(items: FindResultItem[]): FindResultItem[] {
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item?.uri || seen.has(item.uri)) {
      continue;
    }

    seen.add(item.uri);
    deduped.push(item);
  }

  return deduped;
}

export function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

export function selectToolMemories(
  items: FindResultItem[],
  options: {
    limit: number;
    scoreThreshold: number;
  },
): FindResultItem[] {
  const selected: FindResultItem[] = [];

  for (const item of [...dedupeMemoriesByUri(items)].sort(
    (a, b) => clampScore(b.score) - clampScore(a.score),
  )) {
    if (clampScore(item.score) < options.scoreThreshold) {
      continue;
    }

    selected.push(item);
    if (selected.length >= options.limit) {
      break;
    }
  }

  return selected;
}

export function formatMemoryLines(memories: FindResultItem[]): string {
  return memories
    .map((item) => {
      const summary = normalizeMemorySummary(item);
      const score = Math.round(clampScore(item.score) * 100);

      if (summary) {
        return `- [${score}%] ${item.uri}: ${summary}`;
      }

      return `- [${score}%] ${item.uri}`;
    })
    .join("\n");
}

export function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

/**
 * Match a session key against a glob pattern.
 * Rules (same as lossless-claw ignoreSessionPatterns):
 *   ** - matches any characters including ':'
 *   *  - matches any characters except ':'
 * Full-string match (anchored).
 */
export function matchesGlobPattern(sessionKey: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^:]*")
    .replace(/\x00/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(sessionKey);
}

export function matchesAnyPattern(sessionKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlobPattern(sessionKey, pattern));
}

export async function buildMemoryLinesWithBudget(
  memories: FindResultItem[],
  readFn: (uri: string) => Promise<string>,
  options: BuildMemoryLinesOptions,
): Promise<{ lines: string[]; estimatedTokens: number }> {
  let budgetRemaining = options.recallTokenBudget;
  const lines: string[] = [];
  let totalTokens = 0;

  for (const item of memories) {
    if (budgetRemaining <= 0) {
      break;
    }

    const content = await resolveMemoryContent(item, readFn, options);
    const line = `- [${item.category ?? "memory"}] ${content}`;
    const lineTokens = estimateTokenCount(line);
    if (lineTokens > budgetRemaining && lines.length > 0) {
      break;
    }

    lines.push(line);
    totalTokens += lineTokens;
    budgetRemaining -= lineTokens;
  }

  return { lines, estimatedTokens: totalTokens };
}

function normalizeMemorySummary(item: FindResultItem): string {
  return (item.abstract ?? item.overview ?? "").trim();
}

async function resolveMemoryContent(
  item: FindResultItem,
  readFn: (uri: string) => Promise<string>,
  options: BuildMemoryLinesOptions,
): Promise<string> {
  let content: string;

  if (options.recallPreferAbstract && item.abstract?.trim()) {
    content = item.abstract.trim();
  } else if (item.level === 2) {
    try {
      const fullContent = await readFn(item.uri);
      content =
        fullContent && typeof fullContent === "string" && fullContent.trim()
          ? fullContent.trim()
          : item.abstract?.trim() || item.uri;
    } catch {
      content = item.abstract?.trim() || item.uri;
    }
  } else {
    content = item.abstract?.trim() || item.uri;
  }

  if (content.length > options.recallMaxContentChars) {
    content = `${content.slice(0, options.recallMaxContentChars)}...`;
  }

  return content;
}
