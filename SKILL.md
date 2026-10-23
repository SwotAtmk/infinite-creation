---
name: infinite-creation
description: 本地全链路「小说/剧本 → 漫剧/短视频」创作 Agent 解决方案。三种用法：①启动本项目一键跑；②不启动本项目，Agent 按本规范 + skills/ 技能库复刻全流程（剧本→人物圣经/风格→资产生图→分镜→逐镜视频→合并成片）；③接入用户自定义的文生图/图生图/视频/语音 ComfyUI 工作流。当用户要克隆/安装/启动本项目、或用本项目方案生成漫剧/短视频、或接入自定义工作流时使用。
---

# Agent无限创作 · 本地全链路漫剧/短视频创作 Agent 解决方案

## 一、项目介绍

把小说/剧本**全自动**生成带语音的漫剧/短视频成片，不限时长。本地跑通「ComfyUI（MiniMax H3 视频 + Qwen-Image 2.1 文生图/图生图 + Krea2 + Qwen3-TTS）+ Agent + Skill」的全链路。

**核心流程（也是本方案可复刻的方法论）**：

```
小说/剧本/想法
  → 剧本 + 大纲
  → 人物圣经（bible）+ 风格指南（style）   ← 一致性锚点
  → 人物/场景/道具/语音资产生成
  → 分镜脚本（长镜头聚合，不拆碎）
  → 逐镜视频（MiniMax H3 Ref2VA，参考图 + 参考音 → 带语音视频）
  → 自审重试
  → ffmpeg 合并成片
```

**核心能力**：无限视频时长、自动分镜、项目隔离、人物一致性（canonical 参考图跨镜复用）、技能系统、自迭代技能工厂（工作流 → 技能）、断点续跑、分镜级审查/重生成、分阶段运行、显存维护、在线预览。

**技术栈**：Node.js（Next.js 自定义 server）+ node:sqlite + ComfyUI REST/WebSocket + ffmpeg；Agent 自研 ReAct 循环；前端 Next.js 15 + React 18。

## 二、快速启动（启动本项目）

### 前置要求

| 依赖 | 最低版本 | 用途 |
|------|----------|------|
| Node.js | ≥ 22 | 内置 `node:sqlite` |
| pnpm | ≥ 9 | 依赖管理 |
| Bun | 最新 | `pnpm install` 时自动构建 Agent 内核 |
| ffmpeg | 最新 | 合并成片 |
| ComfyUI | — | 生成图片/视频/语音必需（默认 `http://127.0.0.1:8188`） |

### 安装 / 配置 / 启动 / 验证

```bash
git clone https://github.com/SwotAtmk/infinite-creation.git
# 国内加速使用：https://gitcode.com/SwotAtmk/infinite-creation.git
cd infinite-creation
pnpm install            # 自动构建 Agent 内核（首次较慢，需 bun）
pnpm run install:skills # 可选：拉取 MiniMax-H3 官方技能（仓库已含离线快照）

cp config.example.json config.json   # 填 llm.apiKey 与 comfyui.baseUrl
pnpm run dev                          # 单端口 4600，打开 http://127.0.0.1:4600
pnpm test                             # 单元测试
curl http://127.0.0.1:4600/api/health # 期望 {"ok":true}
```

### 常见问题

- 「未检测到 bun」→ 先装 Bun（https://bun.sh）
- Agent 内核构建失败 → `pnpm run build:agent`
- 生成不了图片/视频 → 确认 ComfyUI 已启动且 `comfyui.baseUrl` 正确
- 端口占用 → 改 `config.json` 的 `server.port` 或设 `PORT`

## 三、全链路流程（可脱离本项目复刻的方法论）

> 本节是核心方案。**不启动本项目**时，Agent 可照此流程 + `skills/` 技能库，在任意环境实现同样的「小说 → 视频」。

四阶段调度（本项目内由生成页勾选；复刻时按同样顺序编排）：

| 阶段 | 做什么 | 依赖 | 产出 |
|------|--------|------|------|
| `llm` 文本创作 | 写人物圣经/风格、资产提示词、拆分镜、写视频提示词 | LLM | 大纲、bible/style、分镜、prompt |
| `image` 资产生图 | 人物/场景/道具出图 | ComfyUI 文生图/图生图 | 角色三视图、场景图、道具图、服装/年龄变体 |
| `tts` 音色设计 | 人物音色样本 | ComfyUI TTS | 每个角色的 voice_ref |
| `video` 分镜视频 | 逐镜出带语音视频 + 合并 | ComfyUI r2v + ffmpeg | 分镜视频、成片 |

分步约定（与 `skills/novel-to-video/SKILL.md` 一致）：

1. **剧本/大纲**：输入小说或想法 → 产出 title/logline/characters/scenes/props/storyboard 大纲 JSON。
2. **一致性锚点**：`bible.md`（每个角色唯一外貌/配色/声音 + 衣橱）+ `style.md`（统一画风/光线/色调/镜头语言）。
3. **资产生成**：先加载 `image-prompt-writing` 写图片提示词、`tts-voice-design` 写音色参数，再统一批量提交（文生图人物/场景/道具，图生图换装/年龄变体，TTS 音色）。
4. **分镜脚本**：加载 `story-pipeline-cn` 按「长镜头聚合」拆分（同一场景连续动作+多句对白合并，禁止一句一镜），字段含景别/运镜/光线/画面/对白/sub_shots 时间轴。
5. **视频提示词**：加载 `h3-prompt-writing`，逐镜写 `__MINIMAX_H3_REF_N__` 参考标签 + 英文平铺提示词，再整章批量生成。
6. **自审重试**：逐镜自审、失败重试。
7. **合并导出**：ffmpeg 合并成片。

## 四、技能库与使用规范

### 技能发现与加载

- 技能库在 `skills/` 目录：每个子目录一份 `SKILL.md`（YAML frontmatter：`name` + `description`）+ 可选 `references/`（细分规范）。
- 本项目内加载：`skill(name)` 读技能正文，`skill_reference(name, ref)` 读单个参考文件。
- 脱离本项目时：直接把 `skills/` 当作可移植技能包使用（每个 `SKILL.md` 自带触发条件与执行步骤）。
- **路由规则**：按任务关键词路由到对应技能；未命中时默认走 `novel-to-video`（总流水线）。

### 核心流程技能（5 个，必读）

| 技能 | 用途 | 调用时机 |
|------|------|----------|
| `novel-to-video` | 总流水线（全链路编排） | 用户要「小说 → 成片」 |
| `story-pipeline-cn` | 小说→剧本→分镜拆分（模式 A/B/C） | 写剧本、拆分镜 |
| `image-prompt-writing` | 图片/图生图提示词规范 | 写资产生图/换装/年龄提示词 |
| `h3-prompt-writing` | MiniMax H3 视频提示词 + 参考标签规范 | 写逐镜视频提示词 |
| `tts-voice-design` | 人物音色设计规范 | 设计人物音色 |

### 其余技能库（按类别）

- **剧本/编剧**：`0715-scriptwriter`、`script-master`、`novel-to-skitscreenplay`、`novel-to-storyboard`、`hf-drama-storyboard-script`。
- **漫剧创作**：`manga-drama-generator`、`manju-director-agent`、`ai-manga-planner`、`comic-drama-generator`、`manga-full-stack`、`script-to-manga`、`cinematic-ai-comic-director`、`micro-drama-creator`。
- **一致性/其它类型**：`era-consistency-optimizer`（年代一致）、`3d-animation-short-generator`、`papercraft-stop-motion-explainer`、`paper-collage-explainer-generator`、`music-video-subtitle-generator`、`minimalist-product-ad-generator`、`handdrawn-live-video-generator`、`co-op-game-intro-generator`、`brand-promo-video-generator`。
- **小说写作（网文）**：`ultimate-novel`（路由）、`ultimate-novel-setup`、`ultimate-novel-market-data`、`ultimate-novel-benchmark`、`ultimate-novel-long-scan`、`ultimate-novel-long-analyze`、`ultimate-novel-long-write`、`ultimate-novel-short-scan`、`ultimate-novel-short-analyze`、`ultimate-novel-short-write`、`ultimate-novel-import`、`ultimate-novel-review`、`ultimate-novel-deslop`、`ultimate-novel-cover`、`ultimate-novel-performance-review`。
- **导演分镜优化**：`storyboard_optimization_skill`（项导轻量版V1.8，已有资产/小说转分镜/最终视频提示词）。

（完整技能清单以 `skills/` 目录实际为准，每个 `SKILL.md` 的 frontmatter `description` 是权威触发条件。）

## 五、自定义工作流接入

用户若有**自己的** ComfyUI 工作流，可按四类 `kind` 接入，替代默认工作流：

| kind | 含义 | 典型产出 |
|------|------|----------|
| `t2i` | 文生图 | 角色/场景/道具图 |
| `i2i` | 图生图 / 图像编辑 | 换装、年龄变体、参考图派生 |
| `r2v` | 参考图/参考音 → 视频 | 分镜镜头视频 |
| `tts` | 音色/语音 | 人物 voice_ref |

### 工作流规格（Workflow Spec）

每个工作流用一个「规格」描述如何往 ComfyUI JSON 里写参数。核心字段：

- `roles`：语义角色 → `{ node, field, map? }`。常见角色：`positive_prompt`/`negative_prompt`/`width`/`height`/`seed`/`seconds`/`resolution`/`aspect_ratio`/`image`/`text`/`voice_description`/`filename_prefix`；`map` 用于枚举值翻译（如 `'16:9' → '16:9 (Widescreen)'`）。
- `media`（可选，r2v 必需）：参考素材绑定 —— `targetNode` + `mediaField`/`fieldsByType` + `loaders`（LoadImage/LoadAudio/LoadVideo）+ `reusePool` + `maxImages`(≤9)/`maxAudioVideo`(≤3)。
- `outputs`：产物节点类（`SaveImage`/`SaveVideo`/`SaveAudio`/`SaveAnimatedWEBP`…）。
- `prune`：需删除的节点 id（模板自带硬编码占位参考图/音、被覆盖的 LLM 改写链）。

参考示例见 `lib/core/workflow-specs.js` 的 `DEFAULT_SPECS`（内含 MiniMax H3 r2v、Qwen-Image 2.1/Krea2 t2i、Qwen-Image-Edit i2i、Qwen3-TTS tts 的完整规格）。

### 两种接入方式

**方式 A · 启动本项目（推荐，自动）**：工作流页粘贴 ComfyUI 工作流 JSON → 「分析节点/角色」→「注册工作流 + 生成技能」。系统会：解析节点（加载器/提示词/尺寸/种子/保存）→ 推导规格 → 注册到 `workflows/` + DB → 调用 LLM 起草 `SKILL.md` 并安装为可路由技能 → Agent 立即可当新「工作模式」调用。

**方式 B · 不启动本项目（Agent 手工映射）**：Agent 按上方「工作流规格」字段，把用户提供的 ComfyUI JSON 手动整理成规格（roles/media/outputs/prune），再复刻 `workflow-runner` 的「克隆模板 → 写 roles 参数 → 绑定 media 参考 → prune 无效节点 → 提交 ComfyUI」流程。解析逻辑参考 `analyzeWorkflow()`（识别 LoadImage/LoadAudio/LoadVideo、Save*、KSampler、prompt/text 字段、seed、尺寸）。

## 六、外部 Agent 通过 API 写入内容（harness 写入）

外部 harness（opencode 等）可以把**文本内容**写进一个正在运行的实例：新建项目、小说原文、剧本、分镜、人物圣经/风格。

- **技能**：`harness-skills/ic-writer/SKILL.md`（端点速查 + 铁律；放在 `skills/` 之外，避免被 `scanSkills()` 当成应用内 Agent 的技能）。装到 harness 技能目录：`node scripts/install-writer-skill.mjs`（默认 `~/.agents/skills/ic-writer`，新技能需重启会话）。
- **只走 API**：读写一律通过 `{base}/api/...`；**禁止**直连 `data/ic.db`（只读也不行）、手改 `data/` 下的文件或 `config.json`——绕过去就没有变更日志，既不可回滚，`source`/`batch_id` 也记不上。
- **只写 LLM 文本**：小说/剧本/分镜/上下文/素材提示词；**禁止**触发生成与导出（`/run`、`/stages`、`/regenerate`、`/generate`、`/music`、`/export`）。图片、视频、语音、音乐、成片一律由用户在界面启动。
- **可改写已有产物**：覆盖已生成章节的 `novel`/`script`、逐条改已有分镜正文与 `video_prompt`、覆盖 `bible`/`style`；但 `status/video_path` 等产物字段不可写。
- **补齐的接口**：`PUT …/context`（上下文，落盘 `context/*.md`）、`POST/DELETE …/shots`、`PATCH …/shots/:sid`（可写分镜正文，产物字段不可写）、`PUT …/chapters/:cid/storyboard`（整章批量写分镜）、`GET …/logs`、`POST …/logs/rollback`。章节新增 `script` 字段承载剧本。
- **可回滚日志**：内容表（projects/chapters/shots/assets/reference_images）的每次增删改都在 DB 层留原始行快照，UI / 内置 Agent / 外部 harness 三方写入全部覆盖；支持单条、整批（`batch_id`）、按时间点回滚，带漂移保护（变更之后又被改过 → 409 拒绝，`force:true` 才覆盖）。
- **硬约束**：**没有任何 API 用于删除项目**；回滚也拒绝回滚「项目创建」。日志随用户手动删除项目一并清除，不自动清理。
- 设计细节见 `docs/writer-api-plan.md`。

## 七、使用方式小结

- **要跑本项目**：见「二、快速启动」。
- **要脱离本项目、在自己 Agent 里实现同样方案**：读「三、全链路流程」+ 用「四」的 `skills/` 技能库，按五接入自己的工作流。
- **要用自己的文生图/图生图/视频/语音工作流**：见「五、自定义工作流接入」。
