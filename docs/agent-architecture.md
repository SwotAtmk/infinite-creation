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

## 分阶段运行（生成页 4 阶段拆批）

`GET/POST /api/projects/:id/stages`：把整条流水线拆成 4 个独立阶段，生成页勾选后由 `lib/agent/stages.js` 串行跑选中阶段。

| 阶段 | 进程依赖 | 内容 |
|------|----------|------|
| llm（文本创作/分镜） | LLM | 启动 Agent，写完全部文本，渲染工具全部禁用 |
| image（资产生图） | ComfyUI（禁 CK） | `generate_assets_batch(only:['image'])` 文生图/图生图 |
| tts（音色设计） | ComfyUI | `generate_assets_batch(only:['tts'])` Qwen3-TTS |
| video（分镜视频 + 成片） | ComfyUI（CK 加速） | 逐章串行出镜头视频 + ffmpeg 合并成片 |

- **待办数由代码算**（`pendingByStage`，与各批量工具的跳过条件逐字一致），不启动 27B LLM 去问"还剩什么"——省一次大模型拉起（原设计的缺口）。
- **preflight 预检**：提交前校验所选阶段的 CK 开关与当前 ComfyUI 实例是否匹配、显存是否够（video 必须接 CK 实例、image 必须禁 CK），不通过直接 400 报原因，避免白等。
- **所有 ComfyUI 生成自动调 `/free`**（`generation.freeAfterEvery`，默认 3、0=关闭，可设置页调整；兼容旧键 `videoFreeAfterEvery`）：计数在 `runWorkflow` 统一出口按「生成任务」累计——文生图/图生图/换装/音色/视频都计入（AMD Dynamic VRAM 的显存累积不只在视频触发），对抗任意连续生成的退化。
- 服务启停由用户手动操作：**应用不根据 LLM / ComfyUI 的服务状态决定行为**——不探测对端是否在跑、不因对端在跑而等待或拒绝。勾了什么阶段就照跑什么（同批混勾、vision+渲染、整条流水线都不再拦截）。
- **排队只按「任务」**：所有会碰 ComfyUI / LLM 的任务共用一条队列（`runExclusiveVideo`），只在「确实有别的任务在占用槽位」时串行等待；没有任务时新任务立即执行。排队等待有上限（`generation.videoQueueTimeoutMinutes`，默认 120 分钟），前置任务卡死时排队任务不会无限等；排队中可点停止立即出队。
- **就绪检查只快速失败、不等待**：preflight 勾了哪一侧就探哪一侧（LLM `/models`、ComfyUI `/system_stats`，各 4–5s 超时），服务没起立刻报错退出，不让用户等到 LLM 写完几千字才发现 ComfyUI 没启动。

## 外部 Agent 运行时（可选，MCP 工具桥）

设置页「Agent 运行时」可把执行器从内置 openclaude 切换为本机已安装的 CLI Agent：
Claude Code、Codex CLI、Gemini CLI、Qwen Code、Cursor Agent、Qoder CLI、Grok Build、Hermes，以及自定义命令。
配置写入 `config.json` 的 `agent.runtime`，默认仍是 `openclaude`。

```
设置页 → config.agent.runtime
  → lib/agent/agent-runtime.js::runAgent()
      ├─ openclaude → runOpenClaudeAgent()（现有进程内 SDK，行为不变）
      └─ 外部 Agent → lib/agent/external/runner.js::runExternalAgent()
            ├─ 生成工作区 data/agent-workspaces/<jobId>/
            │    ├─ claude-mcp.json / .gemini / .qwen / .cursor / .qoder / .grok
            │    └─ Hermes 的 hermes-home/config.yaml（复制用户配置后合并，不改原文件）
            ├─ spawn CLI（cwd=工作区，注入 IC_MCP_* 环境变量）
            └─ CLI 连接 lib/agent/external/mcp-server.mjs
                  → tools/list = TOOL_DEFINITIONS（全部领域工具，当前 34 个）
                  → tools/call → runTool() → ComfyUI / SQLite / ffmpeg
```

- **工具桥**：`mcp-server.mjs` 是零新依赖的 newline-delimited JSON-RPC stdio 服务；只暴露 `TOOL_DEFINITIONS`，所有调用仍经过 `guardToolCall` 与参数白名单。stdout 只输出协议帧，`console.*` 全部重定向到 stderr。
- **进度**：MCP 服务把 `tool_start` / `tool_end` / `phase` 写入 `logs/<jobId>.progress.jsonl`，runner 轮询后转成现有 `onProgress`，Web 界面与内置 Agent 口径一致。
- **停止**：runner 检测到 `abortFlags` 后写 `logs/<jobId>.abort`，MCP 服务的 `isAborted` 立即生效；同时杀 CLI 进程树（POSIX 杀进程组，Windows `taskkill /T`）。
- **失败判定**：外部 Agent 退出码非 0、停滞超时、或一次领域工具都没调用（MCP 未接通）都会让任务失败，不会把「只聊了几句」记成完成。
- **环境隔离**：外部 Agent 使用自己的模型/登录态；runner 会清掉内置 openclaude 注入的 `CLAUDE_CODE_USE_OPENAI` / `OPENCLAUDE_*` 及同值的 `OPENAI_BASE_URL` / `OPENAI_MODEL`。
- **SQLite**：外部 MCP 服务与主进程同时写库，`getDb()` 已加 `PRAGMA busy_timeout = 10000`。
- 检查本机安装：`GET /api/agents`；可用性探测：`POST /api/agents/test`。

## 用户改过的值必须真的生效（不被 LLM / 复用逻辑吞掉）

素材库里的「提示词」是用户指令，必须优先于 LLM 与任何「已存在就复用」的捷径：

- **手动保存即加锁**：`PATCH /assets/:aid` 保存非空 `prompt` 时置 `prompt_locked=1`（清空保存则解锁）；
  `update_asset`（LLM 工具）遇到锁定资产不再覆盖 `prompt`，并在返回值里告知 LLM「保持用户手写版本」。
- **改过就必须重做**：`generate_assets_batch` 跳过条件是 `prompt_used === prompt`（音色是 `voice_desc_used === voice_desc`），
  即「提示词没变过」。用户改了提示词 → 两者不等 → 重新生成，而不是沿用旧图。
- **换装 / 年龄变体同理**：`variantReusable` 要求「内容与提示词都没改过」才复用；
  只要描述或提示词变过就原地重生成（不新建同名资产），并用资产自身被改过的提示词（`variantPrompt`）。
  历史遗留的 `Assets.create` 漏收 `prompt` 的缺陷已修：变体提示词现在真的落库，否则改提示词毫无作用。
- **LLM 看得到已有提示词**：`list_assets` / `view_asset` 返回 `prompt` / `prompt_used` / `prompt_locked`，
  否则 LLM 会以为自己才是第一个写提示词的人，把用户的版本覆盖掉。


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
- `lib/agent/agent-runtime.js` —— 运行时选择：内置 openclaude / 外部 Agent
- `lib/agent/external/registry.js` —— 外部 Agent 注册表（新增 Agent 时在这里登记）
- `lib/agent/external/defs/` —— 每个 Agent 一个定义文件（claude/codex/gemini/qwen/cursor-agent/qoder/grok/hermes + shared 共享常量 + custom 自定义命令）
- `lib/agent/external/` —— 检测（detect）、工作区与 MCP 配置（mcp-config）、stdio 服务（mcp-server.mjs）、执行器（runner）
- `lib/agent/job-runner.js` —— startCreateJob 驱动 openclaude agent；runExclusiveVideo 视频任务串行闸门；startStageJob 分阶段任务入口
- `lib/agent/stages.js` —— 分阶段调度（阶段定义 / pendingByStage 待办 / preflight 预检 / 串行执行）
- `lib/agent/tools.js` —— 21 个领域工具定义 + runTool 分派（复用），含视频任务每 N 个自动 /free 释放显存
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
