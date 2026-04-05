import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CaptureSessionState = {
  accumulatedTokens: number;
  lastUpdatedAt: string;
  sessionKey?: string;
};

export type CaptureStateSnapshot = {
  sessions: Record<string, CaptureSessionState>;
  commits: number;
};

type CaptureStateLogger = {
  warn?: (message: string) => void;
};

type CaptureStateStoreOptions = {
  stateFilePath?: string;
  debounceMs?: number;
  logger?: CaptureStateLogger;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

type CaptureStateMeta = {
  commits: number;
  lastUpdatedAt: string;
};

const CAPTURE_STATE_META_KEY = "__meta";
const DEFAULT_CAPTURE_STATE_DEBOUNCE_MS = 5_000;
const DEFAULT_TIMESTAMP = new Date(0).toISOString();

export function getDefaultCaptureStateFilePath(): string {
  const homeDir = normalizeNonEmptyString(process.env.HOME) || process.cwd();
  return join(
    homeDir,
    ".openclaw",
    "extensions",
    "openclaw-openviking-plugin",
    "capture-state.json",
  );
}

export class CaptureStateStore {
  private readonly stateFilePath: string;
  private readonly debounceMs: number;
  private readonly logger?: CaptureStateLogger;
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private readonly sessions = new Map<string, CaptureSessionState>();
  private commits = 0;
  private loaded = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: CaptureStateStoreOptions = {}) {
    this.stateFilePath = options.stateFilePath || getDefaultCaptureStateFilePath();
    this.debounceMs = options.debounceMs ?? DEFAULT_CAPTURE_STATE_DEBOUNCE_MS;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  getAccumulatedTokens(params: { sessionId?: string; sessionKey?: string } = {}): number {
    this.ensureLoaded();

    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (sessionId) {
      return this.sessions.get(sessionId)?.accumulatedTokens ?? 0;
    }

    const sessionKey = normalizeNonEmptyString(params.sessionKey);
    if (!sessionKey) {
      return 0;
    }

    return this.findLatestBySessionKey(sessionKey)?.accumulatedTokens ?? 0;
  }

  getCommitCount(): number {
    this.ensureLoaded();
    return this.commits;
  }

  getSnapshot(): CaptureStateSnapshot {
    this.ensureLoaded();
    return {
      sessions: Object.fromEntries(this.sessions.entries()),
      commits: this.commits,
    };
  }

  recordTokens(sessionId: string, tokenDelta: number, sessionKey?: string): number {
    this.ensureLoaded();

    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return 0;
    }

    const current = this.sessions.get(normalizedSessionId);
    const nextState: CaptureSessionState = {
      accumulatedTokens:
        (current?.accumulatedTokens ?? 0) + Math.max(0, toNonNegativeInteger(tokenDelta)),
      lastUpdatedAt: this.now().toISOString(),
      sessionKey: normalizeNonEmptyString(sessionKey) || current?.sessionKey,
    };

    this.sessions.set(normalizedSessionId, nextState);
    this.dirty = true;
    this.schedulePersist();
    return nextState.accumulatedTokens;
  }

  recordCommit(sessionId: string, sessionKey?: string): number {
    this.ensureLoaded();

    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) {
      return this.commits;
    }

    const current = this.sessions.get(normalizedSessionId);
    this.sessions.set(normalizedSessionId, {
      accumulatedTokens: 0,
      lastUpdatedAt: this.now().toISOString(),
      sessionKey: normalizeNonEmptyString(sessionKey) || current?.sessionKey,
    });
    this.commits += 1;
    this.dirty = true;
    this.persistNow();
    return this.commits;
  }

  flush(): void {
    this.ensureLoaded();
    this.persistNow();
  }

  dispose(): void {
    if (!this.persistTimer) {
      return;
    }

    this.clearTimeoutFn(this.persistTimer);
    this.persistTimer = undefined;
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }

    this.loaded = true;
    try {
      const raw = readFileSync(this.stateFilePath, "utf8");
      const snapshot = parseCaptureState(raw);
      this.commits = snapshot.commits;
      for (const [sessionId, state] of Object.entries(snapshot.sessions)) {
        this.sessions.set(sessionId, state);
      }
    } catch (error) {
      if (!isFileMissingError(error)) {
        this.logger?.warn?.(
          `openclaw-openviking-plugin: failed to load capture state: ${String(error)}`,
        );
      }
    }
  }

  private findLatestBySessionKey(sessionKey: string): CaptureSessionState | undefined {
    let matched: CaptureSessionState | undefined;
    let matchedAt = -1;

    for (const state of this.sessions.values()) {
      if (state.sessionKey !== sessionKey) {
        continue;
      }

      const timestamp = Date.parse(state.lastUpdatedAt);
      if (!matched || timestamp > matchedAt) {
        matched = state;
        matchedAt = Number.isFinite(timestamp) ? timestamp : -1;
      }
    }

    return matched;
  }

  private schedulePersist(): void {
    if (this.debounceMs <= 0) {
      this.persistNow();
      return;
    }

    if (this.persistTimer) {
      this.clearTimeoutFn(this.persistTimer);
    }

    this.persistTimer = this.setTimeoutFn(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, this.debounceMs);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    if (!this.dirty) {
      return;
    }

    if (this.persistTimer) {
      this.clearTimeoutFn(this.persistTimer);
      this.persistTimer = undefined;
    }

    const nowIso = this.now().toISOString();
    const snapshot = this.getSnapshot();
    const payload = serializeCaptureState(snapshot, nowIso);

    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify(payload, null, 2), "utf8");
      this.dirty = false;
    } catch (error) {
      this.logger?.warn?.(
        `openclaw-openviking-plugin: failed to persist capture state: ${String(error)}`,
      );
    }
  }
}

function parseCaptureState(raw: string): CaptureStateSnapshot {
  const parsed = asRecord(JSON.parse(raw));
  if (!parsed) {
    return { sessions: {}, commits: 0 };
  }

  const nestedSessions = asRecord(parsed.sessions);
  if (nestedSessions) {
    return {
      sessions: parseCaptureSessions(nestedSessions),
      commits: toNonNegativeInteger(parsed.commits),
    };
  }

  const sessions: Record<string, CaptureSessionState> = {};
  let commits = 0;

  for (const [key, value] of Object.entries(parsed)) {
    if (key === CAPTURE_STATE_META_KEY) {
      const meta = asRecord(value);
      commits = toNonNegativeInteger(meta?.commits);
      continue;
    }

    const session = parseCaptureSession(value);
    if (!session) {
      continue;
    }

    sessions[key] = session;
  }

  return { sessions, commits };
}

function parseCaptureSessions(input: Record<string, unknown>): Record<string, CaptureSessionState> {
  const sessions: Record<string, CaptureSessionState> = {};

  for (const [key, value] of Object.entries(input)) {
    const session = parseCaptureSession(value);
    if (!session) {
      continue;
    }

    sessions[key] = session;
  }

  return sessions;
}

function parseCaptureSession(value: unknown): CaptureSessionState | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    accumulatedTokens: toNonNegativeInteger(record.accumulatedTokens),
    lastUpdatedAt: normalizeNonEmptyString(record.lastUpdatedAt) || DEFAULT_TIMESTAMP,
    sessionKey: normalizeNonEmptyString(record.sessionKey) || undefined,
  };
}

function serializeCaptureState(
  snapshot: CaptureStateSnapshot,
  nowIso: string,
): Record<string, CaptureSessionState | CaptureStateMeta> {
  const output: Record<string, CaptureSessionState | CaptureStateMeta> = {
    [CAPTURE_STATE_META_KEY]: {
      commits: snapshot.commits,
      lastUpdatedAt: nowIso,
    },
  };

  for (const sessionId of Object.keys(snapshot.sessions).sort()) {
    output[sessionId] = snapshot.sessions[sessionId]!;
  }

  return output;
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function isFileMissingError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : "";
  return code === "ENOENT";
}
