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
- 设计动机：本机 24GB 显存 + 32GB 内存，LLM（27B GGUF ≈15.7GB）与 ComfyUI 无法同时常驻，拆批后每批只拉起所需进程。

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
