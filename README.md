# openclaw-openviking-plugin

An [OpenClaw](https://openclaw.ai) plugin that integrates with [OpenViking](https://github.com/volcengine/openviking) for long-term memory.

**Hook-only** — does not register as a context engine. Works alongside LCM or any other context engine without conflict.

## Features

- **autoRecall** — searches OpenViking memories before each prompt and injects relevant context
- **autoCapture** — commits new conversation messages to OpenViking after each turn for memory extraction
- **memory_recall** tool — model-triggered memory search
- **memory_store** tool — model-triggered memory write
- **memory_forget** tool — model-triggered memory deletion

## Requirements

- OpenClaw gateway
- OpenViking server running and accessible via HTTP

## Installation

```bash
openclaw plugins install /path/to/openclaw-openviking-plugin
```

Or copy the directory to `~/.openclaw/extensions/openclaw-openviking-plugin/`.

## Configuration

```json
{
  "plugins": {
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

## Testing

```bash
npm install

# Unit tests (no server required)
npm run test:unit

# Integration tests (requires OV server)
OV_BASE_URL=http://127.0.0.1:1934 npm run test:integration
```

Integration tests skip automatically if the server is unreachable.

## License

MIT
