# openclaw-openviking-plugin

[OpenClaw](https://openclaw.ai) 的长期记忆插件，通过集成 [OpenViking](https://github.com/volcengine/openviking) 实现 AI Agent 的持久化记忆管理。

**Hook-only 设计** — 不注册为 context engine，不占用独占槽位，可与 LCM 或其他 context engine 无冲突共存。

## 功能

- **autoRecall** — 每次对话前自动搜索 OpenViking 记忆，将相关内容注入 prompt
- **autoCapture** — 每轮对话结束后自动将新增消息提交到 OpenViking，触发记忆提取
- **memory_recall** 工具 — 模型主动触发记忆搜索
- **memory_store** 工具 — 模型主动写入记忆
- **memory_forget** 工具 — 模型主动删除记忆

## 命令

- `/ov`、`/openviking`，或显式 `/ov status` — 查看插件状态和诊断信息
- 状态输出包含：
  - **Plugin** — `autoRecall`、`autoCapture`、`captureSessionFilter`
  - **Config** — `baseUrl` 以及 recall/capture 相关阈值与限制
  - **OV Server** — 服务可达性与版本号
  - **Queue** — 本地 OpenViking 队列按状态统计（仅在 OV server 为本地地址时显示）
  - **Memories** — user/agent 记忆按子目录细分统计
- `/ov help` — 查看命令帮助

## 依赖

- OpenClaw gateway
- OpenViking server（本地或远程，HTTP 可访问）

## 安装

### 通过 OpenClaw CLI（推荐）

```bash
openclaw plugins install openclaw-openviking-plugin
```

更新到最新版本：

```bash
openclaw plugins update openclaw-openviking-plugin
```

### 使用 `install.sh`（从源码安装）

```bash
git clone https://github.com/liushuangls/openclaw-openviking-plugin
cd openclaw-openviking-plugin
./install.sh
```

脚本会自动完成：复制插件文件 → 安装依赖 → 更新 `openclaw.json` → 重启 gateway。

已安装的情况下重复执行为**更新模式**，只同步文件和重启，不覆盖配置。

```bash
# 指定 OV server 地址
OV_BASE_URL=http://192.168.1.100:1934 ./install.sh
```

### 手动安装

将目录复制到 `~/.openclaw/extensions/openclaw-openviking-plugin/`，在目录内执行 `npm install --omit=dev`，然后按下方配置格式更新 `openclaw.json`，重启 gateway 生效。

## 配置

在 `openclaw.json` 中添加：

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
          "commitTokenThreshold": 1000
        }
      }
    }
  }
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:1934` | OpenViking server 地址 |
| `apiKey` | `""` | API Key（按需填写） |
| `autoRecall` | `true` | 每次 prompt 前自动召回相关记忆 |
| `autoCapture` | `true` | 每轮对话结束后自动提交并提取记忆 |
| `captureSessionFilter` | `[]` | 仅当 `sessionKey` 完整匹配任一已配置的 glob 模式时才自动捕获，例如 `["agent:*:telegram:direct:**"]` |
| `recallLimit` | `6` | 单次最多注入的记忆条数 |
| `recallScoreThreshold` | `0.15` | 最低相关性分数（0–1） |
| `recallTokenBudget` | `2000` | 注入记忆的最大 token 数 |
| `recallMaxContentChars` | `500` | 单条记忆最大字符数 |
| `commitTokenThreshold` | `1000` | 提交记忆的最低 token 阈值（0 = 每轮都提交） |

## 测试

```bash
npm install

# 单元测试（不需要 OV server）
npm run test:unit

# 集成测试（需要 OV server 运行中）
OV_BASE_URL=http://127.0.0.1:1934 npm run test:integration
```

OV server 不可达时集成测试自动跳过。

## 与 LCM 共存

本插件只使用 hook（`before_prompt_build` + `agent_end`），不设置 `kind: "context-engine"`，不占用独占的 context engine 槽位，可与 [lossless-claw](https://github.com/martian-engineering/lossless-claw) 等插件同时运行。

- **LCM** 负责对话压缩与上下文管理
- **OpenViking 插件** 负责跨 session 的长期记忆自动捕获与召回

## 升级注意事项

升级 OpenViking server 前，建议先对比官方插件 `client.ts` 是否有变更，有则同步后跑一次集成测试再升级。最敏感的接口是 `fs/ls` 和 `system/status`（URI 归一化依赖这两个）。

## License

MIT
