# openclaw-openviking-plugin

[中文文档](./README_CN.md)

An [OpenClaw](https://openclaw.ai) plugin that integrates with [OpenViking](https://github.com/volcengine/openviking) for long-term memory.

**Hook-only** — does not register as a context engine. Works alongside LCM or any other context engine without conflict.

## Features

- **autoRecall** — searches OpenViking memories before each prompt and injects relevant context
- **autoCapture** — commits new conversation messages to OpenViking after each turn for memory extraction
- **memory_recall** tool — model-triggered memory search
- **memory_store** tool — model-triggered memory write
- **memory_forget** tool — model-triggered memory deletion

## Slash Commands

- `/ov`, `/openviking`, or explicit `/ov status` — show plugin status and diagnostics
- Status output includes:
  - **Plugin** — `autoRecall`, `autoCapture`, `captureSessionFilter`
  - **Config** — `baseUrl` and recall/capture limits
  - **OV Server** — server reachability and version
  - **Queue** — local OpenViking queue counts by status (shown when the OV server is local)
  - **Memories** — user/agent memory counts broken down by subdirectory
- `/ov help` — show command help

## Requirements

- OpenClaw gateway
- OpenViking server running and accessible via HTTP

## Installation

### Via OpenClaw CLI (recommended)

```bash
openclaw plugins install openclaw-openviking-plugin
```

To update to the latest version:

```bash
openclaw plugins update openclaw-openviking-plugin
```

### Using `install.sh` (from source)

```bash
git clone https://github.com/liushuangls/openclaw-openviking-plugin
cd openclaw-openviking-plugin
./install.sh
```

The script copies plugin files, installs dependencies, updates `openclaw.json`, and restarts the gateway automatically. Re-running it on an already-installed plugin performs an **update** (syncs files + restarts, config unchanged).

```bash
# Custom OV server address
OV_BASE_URL=http://192.168.1.100:1934 ./install.sh
```

### Manual

Copy the directory to `~/.openclaw/extensions/openclaw-openviking-plugin/`, run `npm install --omit=dev` inside it, then add the plugin to `openclaw.json` (see Configuration below) and restart the gateway.

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-openviking-plugin"],
    "entries": {
      "openclaw-openviking-plugin": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:1934",
          "apiKey": "",
          "autoRecall": true,
          "autoCapture": true,
          "recallLimit": 6,
          "recallScoreThreshold": 0.15,
          "recallTokenBudget": 2000,
          "recallMaxContentChars": 500,
          "commitTokenThreshold": 0
        }
      }
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:1934` | OpenViking server URL |
| `apiKey` | `""` | API key (if required) |
| `autoRecall` | `true` | Inject relevant memories before each prompt |
| `autoCapture` | `true` | Commit conversation turns to OV after each response |
| `captureSessionFilter` | `[]` | Only auto-capture when `sessionKey` fully matches any configured glob pattern, e.g. `["agent:*:telegram:direct:**"]` |
| `recallLimit` | `6` | Max memories to inject per turn |
| `recallScoreThreshold` | `0.15` | Minimum relevance score (0–1) |
| `recallTokenBudget` | `2000` | Max tokens for injected memory context |
| `recallMaxContentChars` | `500` | Max characters per memory snippet |
| `commitTokenThreshold` | `0` | Min tokens in a turn before committing (0 = always) |

## Testing

```bash
npm install

# Unit tests (no server required)
npm run test:unit

# Integration tests (requires OV server)
OV_BASE_URL=http://127.0.0.1:1934 npm run test:integration
```

Integration tests skip automatically if the server is unreachable.

## Coexistence with LCM

This plugin uses **hooks only** (`before_prompt_build` + `agent_end`). It does not set `kind: "context-engine"` and does not occupy the exclusive context engine slot, so it runs alongside [lossless-claw](https://github.com/martian-engineering/lossless-claw) or any other context engine without conflict.

## License

MIT
