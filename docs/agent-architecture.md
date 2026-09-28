# Agent 运行架构（openclaude 二开对接）

## 一句话结论

openclaude 的核心（Agent 循环引擎）已经以**源码形式搬进本项目**（`vendor/openclaude/`），
从源码构建出 SDK（`dist/sdk.mjs`），再由本项目的 Node 进程**进程内 import** 使用。
**不是两个独立项目之间的子进程 / HTTP 调用**——openclaude 是当前项目进程里的一个模块。

## 运行逻辑（一次「生成」的完整链路）

```
Web「生成」按钮
  → server.js（自定义 server，端口 4600）
  → startCreateJob()                              [lib/agent/job-runner.js]
  → runOpenClaudeAgent()                          [lib/agent/openclaude-agent.js]
      ├─ import query/tool/createSdkMcpServer
      │    from '../../vendor/openclaude/dist/sdk.mjs'   ← 进程内模块，非子进程
      ├─ 配置 provider（LLM 接口打通）
      │    env: OPENAI_BASE_URL/API_KEY/MODEL
      │         = config.json 的 llm.baseUrl/apiKey/model
      │         → 打到 new-api（就是本项目的 LLM 接口）
      ├─ 配置 persona + 技能目录
      │    systemPrompt = buildSystemPrompt()（含 13 个技能的目录 + 技能→任务映射）
      ├─ 注册 21 个 ComfyUI 工具（业务流打通）
      │    tool(name, desc, schema, handler)  →  handler 直接调本工程 runTool()
      │         → createToolRuntime + HANDLERS → ComfyUI / 数据库 / ffmpeg
      │    （其中 skill(name) 工具 → loadSkillWithResources → 本项目 skills/ 目录）
      ├─ 禁用 openclaude 自带 Bash/Read/Write/Task/WebFetch 等文件系统/子代理/联网工具
      └─ query({ prompt, options }) 跑 agent loop
            → 每步 tool_use → 回调我的 handler → runTool
            → 流式 onProgress → Web 界面实时展示
```

## 三个「打通」分别落在哪里

| 目标 | 落地方式 | 位置 |
|------|----------|------|
| 核心嫁接 | openclaude 源码 vendored + 从源码构建 dist/sdk.mjs + 进程内 import | `vendor/openclaude/` |
| LLM 接口打通 | config.json 的 llm → 映射为 OPENAI_* 环境变量 | `openclaude-agent.js::providerEnv` |
| Skill 打通 | persona 注入技能目录；`skill(name)` 工具加载 skills/ 下 SKILL.md + references | `skills/` + `skill-engine.js` |
| 业务流程对接 | 21 个工具（get_project/set_storyboard/generate_chapter_videos/assemble_video 等）→ runTool → ComfyUI/DB | `tools.js` + `job-runner.js` |

## 关键文件

- `vendor/openclaude/` —— openclaude 完整源码（3450 文件）+ 构建产物 dist/（构建物不入库）
- `lib/agent/openclaude-agent.js` —— 对接层：provider/工具/persona/禁用工具/流式进度
- `lib/agent/job-runner.js` —— startCreateJob 驱动 openclaude agent
- `lib/agent/tools.js` —— 21 个领域工具定义 + runTool 分派（复用）
- `lib/agent/skill-engine.js` —— 技能加载（复用）
- `lib/core/llm.js` —— 本项目自带 llmChat（用于 skill-factory/兜底，openclaude 用自己的 client 打同一端点）

## 为什么不是「两个项目互相调用」

1. 运行期没有 `spawn`/`child_process`/HTTP 去调 openclaude——SDK 是 `import` 进来的模块。
2. `bin/openclaude`（CLI）与 `dist/cli.mjs` 虽已构建，但**未使用**；走的是 SDK 编程接口（query）。
3. vendor/openclaude 只是本仓库里的一个目录（源码 + 构建环境），运行时被本项目进程 import。

## 构建 / 重新构建（改了源码后）

```bash
cd vendor/openclaude
bun install --ignore-scripts   # sharp 是可选原生依赖，构建产物时跳过其脚本
bun run build                  # 产出 dist/sdk.mjs + dist/cli.mjs
```

改了 `vendor/openclaude/src/` 后需要重新 build，dist 才会更新；本项目对接层无需改动。
