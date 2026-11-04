# 技术文档 · Agent无限创作

面向开发者与部署者的技术说明：技术栈、目录结构、环境准备与启动、首次配置、使用流程、API、外部写入接口、测试与限制。

> [← 返回 README](../README.md) · English: [Technical Documentation](./technical_EN.md)

## 目录

- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [环境准备与启动](#环境准备与启动)
- [首次配置](#首次配置)
- [使用流程](#使用流程)
- [自迭代：新工作流 → 新技能](#自迭代新工作流--新技能)
- [API 一览](#api-一览)
- [外部写入：让 Claude Code / opencode 帮你写内容](#外部写入让-claude-code--opencode-帮你写内容)
- [测试](#测试)
- [说明与限制](#说明与限制)

## 技术栈

- 后端：Node.js（Next.js 自定义 server）+ node:sqlite + ComfyUI REST/WebSocket + ffmpeg，零原生编译依赖。
- 「无限・秩影」：内置 lemo-opuscar 代码电影技能（Node + three.js + ffmpeg + 可选 Python/Chromium），由 Agent 生成渲染脚本并输出成片，完全不经过 ComfyUI。
- Agent：内置 openclaude 内核（进程内 SDK）+ 可选外部 Agent 运行时（本机 CLI 经 MCP 工具桥），工具注册表 + 技能引擎 + 技能工厂。
- 前端：Next.js 15 + React 18（经典界面，App Router）· Studio 界面：Vite + React 18（`studio/`）。
- 结构：单包 —— `app/`（页面 + 30+ 个 API 端点）· `lib/`（core/agent/shared 复用逻辑）· `server.js`（自定义 server：WebSocket 进度推送 + `/files` 静态托管，支持 Range 流式播放视频）。

## 目录结构

```
infinite-creation/
├── app/                 # Next.js App Router（页面 + API 端点）
├── studio/              # Studio 前端（Vite + React 18，默认界面；含「无限・秩影」工作台）
├── public/samples/      # 内置样例库（每个子目录一份 sample.json + 成片 + 素材，可预览/一键试用）
├── lib/                 # 复用逻辑：core（ComfyUI/LLM/DB/ffmpeg）· agent（内置 openclaude + 外部 Agent + 技能）· shared（常量）
│   └── agent/external/  #   外部 Agent 运行时：defs/（每个 CLI 一个定义文件）· registry（注册表）· detect（检测）· mcp-config · mcp-server（MCP 服务）· runner（执行器）
├── server.js            # 自定义 server（WebSocket 进度推送 + /files 静态托管，Range 流式）
├── workflows/           # ComfyUI 工作流模板（MiniMax H3 视频 / Qwen-Image 2.1 图·文 / Krea2 / Qwen3-TTS，含 GGUF 量化版）
├── start-studio.sh / start-studio.bat   # 后台启动器（Studio 前端 4710 + 独立后端 4610）
├── start-infinite-creation.bat    # Windows 一键后台启动（经典界面 4600）
├── stop-infinite-creation.bat     # Windows 停止服务
├── skills/              # 技能库（9 官方 + novel-to-video + lemo-opuscar（66 风格模板）+ 自定义）
├── scripts/install-skills.mjs   # 拉取 MiniMax-H3 官方技能
├── scripts/dev.mjs      # pnpm run dev 启动器：前台双进程实时日志；--background 后台启动
├── tests/               # 单元测试：unit.test.mjs + external-agents.test.mjs（外部 Agent 定义 / 自定义命令 / MCP 握手）
├── vendor/openclaude/           # Agent 内核源码（dist/ 构建产物不入库，需本地构建）
└── data/                # 运行时（gitignore）：SQLite + projects/<id>/…
```

> **关于 node_modules**：依赖不入库。pnpm 只在项目根目录生成一个 `node_modules`（真实依赖统一放在 `node_modules/.pnpm/`）。**只需在项目根目录执行一次 `pnpm install`**。

## 环境准备与启动

### 前置要求

- Node.js ≥ 22（后端使用内置 `node:sqlite`；Agent 内核要求 `>= 22`）
- pnpm ≥ 9（`npm i -g pnpm`）
- Bun（`pnpm install` 会自动用它构建一次 Agent 内核，安装见 <https://bun.sh>）
- ffmpeg（合片必需，见 <https://ffmpeg.org/download.html>）

### 步骤

```bash
# 克隆项目到本地
git clone https://github.com/SwotAtmk/infinite-creation.git
cd infinite-creation

# 1. 安装全部依赖（仅需在根目录执行一次，会自动构建 Agent 内核）
pnpm install

# 2. 拉取 MiniMax-H3 官方技能（可选，仓库已含离线快照）
pnpm run install:skills

# 3. 开发模式：默认前台启动 Studio（独立后端 4610 + 前端 4710，日志实时输出）
pnpm run dev
# 浏览器打开 http://127.0.0.1:4710
# Ctrl+C 同时停止前端与后端

# 需要后台常驻（日志写入文件）时
pnpm run dev:background

# 经典界面（旧版单端口 4600）开发模式
pnpm run dev:classic
# 浏览器打开 http://127.0.0.1:4600

# 4. 生产模式
# 经典界面：单端口 4600，由后端托管前端构建产物
pnpm run build && pnpm start
# 浏览器打开 http://127.0.0.1:4600

# Studio：构建前端 + 独立后端（生产）
./start-studio-prod.sh        # Windows：start-studio-prod.bat
# 浏览器打开 http://127.0.0.1:4710
```

> Windows 用户可直接双击根目录 `start-studio.bat`（Studio，后端 4610 + 前端 4710）或 `start-infinite-creation.bat`（经典界面 4600）一键后台启动；停止分别用 `stop-studio.bat` / `stop-infinite-creation.bat`。

> **Studio 是默认开发界面**：`pnpm run dev` 在前台同时启动独立后端 4610 与 Studio 前端 4710，日志直接输出到终端，`Ctrl+C` 一并停止；需要后台常驻时用 `pnpm run dev:background`（内部调用 `start-studio.sh` / `start-studio.bat`）。
> ```bash
> pnpm run dev:background       # 后台启动，日志写入 logs/ 与 studio/logs/
> ./start-studio.sh             # 等价的后台脚本（macOS / Linux）
> ./stop-studio.sh              # 只停止 Studio
> ./start-infinite-creation.sh  # 经典界面，打开 http://127.0.0.1:4600
> ```
> Studio 配置说明见 [studio/README.md](../studio/README.md)。

> Agent 内核 `vendor/openclaude/dist/` 是构建产物、不入库，`pnpm install` 会自动构建一次（幂等，已存在则跳过）。只有当你改动了 `vendor/openclaude/src/` 源码后，才需要手动重跑 `pnpm build:agent`。构建细节见 [agent-architecture.md](./agent-architecture.md)。

### 分别启动 Studio 与经典界面

两套界面可以独立运行，共用同一份 `config.json` 与数据库：

```bash
# ── Studio（默认，后端 4610 + 前端 4710）────────────────
pnpm run dev                 # 前台：日志实时输出，Ctrl+C 同时停止前后端
pnpm run dev:background      # 后台：日志写入 logs/ 与 studio/logs/

# 也可以手动分两个终端：
# 终端 1：Studio 后端（开发）
PORT=4610 NEXT_DIST_DIR=.next-studio-dev pnpm run dev:classic
# 终端 2：Studio 前端
pnpm --filter studio dev

# Studio 生产
./start-studio-prod.sh       # Windows：start-studio-prod.bat

# ── 经典界面（旧版单进程，4600）────────────────────────
pnpm run dev:classic         # 开发模式
pnpm run build && pnpm start # 生产模式
```

Windows `cmd` 里设置环境变量：

```bat
set PORT=4610
set NEXT_DIST_DIR=.next-studio-dev
pnpm run dev:classic
```

> 开源版不包含账号、管理后台、积分计费与内容审核；系统设置（ComfyUI / LLM / 工作流 / 硬件 / 生成参数）直接开放。
>
> 若生产构建报 `EPERM ... Application Data`，是 Next 文件追踪扫描用户主目录导致；构建前临时把 HOME/USERPROFILE 指向本地目录即可（`start-studio-prod.bat` 已内置该处理）：
> ```bash
> HOME="$PWD/.build-home" USERPROFILE="$(cygpath -w "$PWD/.build-home")" pnpm build
> ```

## 首次配置

点右上角 ⚙ 设置：

1. ComfyUI 服务地址：默认 `http://127.0.0.1:8188`，点「测试连接」确认。
2. Agent 运行时（可选）：默认「内置 openclaude」；也可切换为「外部 Agent（本机 CLI）」，选择本机已安装的 CLI Agent（Claude Code / Codex CLI / Gemini CLI / Qwen Code / Cursor Agent / Qoder CLI / Grok Build / Hermes / 自定义命令），由外部 Agent 通过本地 MCP 工具桥接管流水线。
3. LLM（Agent 大脑，OpenAI 兼容）：填 Base URL（需以 `/v1` 结尾）、模型、API Key。默认使用 deepseek-v4-flash-vision-exp 模型（内置 openclaude 使用此配置；外部 Agent 使用其自身模型与登录态）。
4. 生成维护（可选）：设置「每 N 个生成后释放 ComfyUI 显存」（默认开启 = 3，0 = 关闭），按**所有 ComfyUI 生成任务**计数（文生图/图生图/换装/音色/视频都计入——AMD 显卡 + Dynamic VRAM 下任意连续生成都会逐步变慢）。释放后下一个生成需重新加载模型（多花约 1~3 分钟）。检测到 ComfyUI 未启用 Dynamic VRAM 时界面会提示建议关闭。

配置保存在根目录 config.json（不入库）。生成参数（超时分钟、并发、释放频率）可直接编辑 config.json 的 `generation` 节。

### 数据库：SQLite / PostgreSQL

默认用 SQLite（`data/ic.db`），零安装、直接启动。正式部署可以换成 PostgreSQL，**两套库共用同一份表结构**，业务代码不需要改。

环境变量优先（推荐）：

```bash
# 快速启动（默认）
IC_DB=sqlite IC_DB_SQLITE_PATH=/data/ic.db

# 正式部署
IC_DB=postgres DATABASE_URL=postgres://user:pass@127.0.0.1:5432/infinite_creation

# 媒体文件固定目录（Docker 挂载）
IC_MEDIA_DIR=/data/projects
# 配置文件也放挂载卷（否则会写进镜像层）
IC_CONFIG=/data/config.json
```

也可以写在 `config.json` 的 `db` 节（参见 `config.example.json`），但环境变量优先。`DATABASE_URL` 存在且没有显式 `IC_DB` 时会自动选 PostgreSQL。

**迁移 / 同步数据**（表结构复用同一份 `initSchema`，不会出现两套 schema 漂移）：

```bash
# SQLite → PostgreSQL
node scripts/db-migrate.mjs --from sqlite --to postgres \
  --to-url postgres://user:pass@127.0.0.1:5432/infinite_creation

# PostgreSQL → SQLite
node scripts/db-migrate.mjs --from postgres --to sqlite \
  --from-url postgres://user:pass@127.0.0.1:5432/infinite_creation \
  --to-sqlite data/ic-pg-copy.db

# 先清空目标表再写入（默认按 id upsert，可重复执行）
node scripts/db-migrate.mjs --from sqlite --to postgres --replace
```

迁移按主键 upsert，项目/素材/分镜/任务/队列/变更日志都会拷贝。媒体文件不在数据库里：图片和视频都在 `IC_MEDIA_DIR`（默认 `<data>/projects`）下，换库后继续用同一个目录或 Docker 挂载卷即可，不需要重新生成。

> 说明：PostgreSQL 是通过 worker 线程提供同步门面的（现有业务层是同步 SQL）。这保证了零改造切换，但每次查询会阻塞当前进程事件循环；PostgreSQL 建议和本服务在同一台机器 / Docker 内网，不要接高延迟远程库。后续如果接远程库，可以再把 repository 改成 async。
>
> Docker 打包时注意保留 `lib/core/pg-worker.mjs` 和 `node_modules/pg`：PostgreSQL 驱动在 worker 线程里按文件路径加载，不会被 Next 的静态追踪自动收进去。媒体、SQLite 库、配置文件分别用 `IC_MEDIA_DIR`、`IC_DB_SQLITE_PATH`、`IC_CONFIG` 指到挂载卷即可。

### ComfyUI 安装与云端算力

ComfyUI 本体安装、所需工作流与模型、以及 RunningHub 云端算力接入，已移至 README 的 [ComfyUI 配置](../README.md#comfyui-配置) 一节。

## 使用流程

1. 新建项目 → 粘贴小说原文（或一句话想法）+ 风格。
2. 在「章节管理」页点某章的「操作」，勾选要跑的阶段（文本创作 / 资产生图 / 音色设计 / 分镜视频，可只勾一部分用于续跑），点 ▶ 开始 → 控制台实时看进度（无需任何中途操作）。
3. 视频阶段跑完自动生成背景音乐并合并成片；到「分镜审查」逐段预览，对不满意的镜头点 ↻ 重新生成（可填反馈）；「背景音乐」页可手动生成/预览/选择背景音乐并应用到多个章节。
4. 到「成片」页在线预览（进度条可拖动），按需下载带字幕 / 不带字幕视频或 SRT 字幕文件；不再需要的成片可单个删除或勾选批量删除。

### 无限・秩影（代码电影）使用流程

1. 左侧菜单进入「无限・秩影」，按分类筛选风格卡片（共 66 个模板），点卡片上的「使用风格」；也可以切到「自定义风格」直接填写风格描述。
2. 在创建弹窗里上传任意素材（图片 / 音频 / 视频 / 文档 / 数据 / 字体等），图片、视频、音频会显示缩略图；填写提示词后点「创建生成任务」。表单支持「清空表单」一键重置。
3. 也可以点右上角「预览样例」查看内置样例的成片、素材与提示词，并「一键试用」把样例素材上传到当前项目、自动填好表单。
4. 任务由 Agent 在本机执行 lemo-opuscar 技能渲染，不占用 ComfyUI 队列；「生成记录」可查询、编辑、重新生成、停止、删除或批量删除，运行中的任务可打开「运行日志」查看实时输出。

> 首次使用「无限・秩影」需要安装技能依赖（Node.js、ffmpeg、Python，以及 Chromium headless 渲染浏览器）：
> `sh skills/lemo-opuscar/plugin/skills/lemo-opuscar/scripts/setup.sh deps`（TTS/音乐需要时再加 `voice` / `music`）。

## 自迭代：新工作流 → 新技能

工作流 页粘贴新的 ComfyUI 工作流 JSON → 「分析节点/角色」→「注册工作流 + 生成技能」。系统会：解析节点（加载器/提示词/尺寸/种子/保存…）→ 推导工作流规格（roles/media/outputs）→ 注册到 workflows/ + DB → 调用 LLM 起草 SKILL.md 并安装为可路由技能 → Agent 即可把它当作新的「工作模式」调用。

## API 一览

| 方法       | 路径                                      | 说明              |
| -------- | --------------------------------------- | --------------- |
| GET/POST | /api/projects                           | 项目列表 / 创建       |
| POST     | /api/projects/:id/run                   | 启动全自动生成         |
| POST     | /api/projects/:id/stop                  | 停止运行中任务         |
| GET      | /api/projects/:id/assets?category=      | 资产（分类）          |
| GET      | /api/projects/:id/shots                 | 分镜              |
| POST     | /api/projects/:id/shots/:sid/regenerate | 单分镜重生成          |
| POST     | /api/projects/:id/export                | 合并导出成片（按项目开关烧录字幕，并生成无字幕副本与 SRT） |
| GET/DELETE | /api/projects/:id/exports             | 成片列表 / 删除成片（支持批量，连带清理无字幕副本与 SRT） |
| GET      | /api/projects/:id/stages                | 各阶段待办数 + 阶段定义  |
| POST     | /api/projects/:id/stages                | 分阶段运行（勾选 llm/image/tts/video 起一批，含预检） |
| POST     | /api/projects/:id/music                 | 生成背景音乐（新建 / 编辑后重新生成一条音乐资产） |
| POST     | /api/projects/:id/music/apply           | 把背景音乐应用到多个章节并重新合成成片 |
| GET/PUT  | /api/projects/:id/context               | 上下文：人物圣经 / 风格 / 连续性（同时落盘 context/*.md） |
| PUT      | /api/projects/:id/chapters/:cid/storyboard | 整章批量写分镜（单次 ≤500 条） |
| POST/DELETE | /api/projects/:id/shots              | 新建 / 删除单个分镜     |
| PATCH    | /api/projects/:id/shots/:sid            | 改单个分镜正文（生成结果字段不可写） |
| GET      | /api/projects/:id/logs                  | 变更日志：谁在什么时候改了什么（回滚依据） |
| POST     | /api/projects/:id/logs/rollback         | 回滚：单条 / 整批 / 按时间点 |
| POST     | /api/projects/:id/jobs/:jobId/cancel    | 取消 / 停止任务（含「无限・秩影」任务） |
| GET      | /api/opuscar/styles                     | 「无限・秩影」风格模板列表（lemo-opuscar，含分类与预览图） |
| GET      | /api/opuscar/samples                    | 内置样例库（`public/samples/`，返回成片与素材 URL） |
| GET/POST | /api/projects/:id/opuscar               | 记录列表 / 创建生成（传 `asset_id` 为重新生成） |
| GET      | /api/skills                             | 技能列表            |
| GET/POST | /api/workflows                          | 工作流列表 / 注册（自迭代） |
| GET/PUT  | /api/config                             | 配置              |
| WS       | /ws                                     | 任务进度推送          |

## 外部写入：让 Claude Code / opencode 帮你写内容

除了在界面里点，你也可以让本机的 AI 编程工具（Claude Code、opencode、Codex、Trae 等）直接把**文字内容**写进正在运行的项目：新建项目、写小说原文、写剧本、写分镜、写人物圣经/风格。典型场景是「手里已经有一部长篇小说，想批量导入并拆成章节」。

它**只写文字**：不会帮你生图、生视频、配音、配乐、导出成片——那些仍然在界面里点。

### 三步用起来

```bash
# 1. 装技能（只需一次；装完重启一下 AI 工具，它才会发现新技能）
pnpm run install:ic-writer     # 默认装到 ~/.agents/skills/ic-writer/

# 2. 起服务（默认启动 Studio：界面 http://127.0.0.1:4710，API 4610）
pnpm run dev

# 3. 对 AI 工具说人话，例如：
#    「把这本小说写进 infinite-creation，一章一段」
#    「给这个项目写 3 章剧本」
#    「把第 2 章的分镜表重写一遍」
```

> 写作技能默认连接 `http://127.0.0.1:4600`（经典界面后端）；使用 Studio 时把它指向 Studio 后端即可：`IC_BASE_URL=http://127.0.0.1:4610`。

技能源就在仓库里：`harness-skills/ic-writer/SKILL.md`（`pnpm run install:ic-writer` 就是把它复制到技能目录）。想装到别处：`node scripts/install-writer-skill.mjs --target <你的技能目录>`。

### 能写什么、不能写什么

|  |  |
|---|---|
| ✅ 能写 | 项目属性、小说原文、剧本、分镜（台词/画面/镜头/时长等）、人物圣经/风格/连续性、素材提示词；**已经生成过的**这些内容也能改写覆盖 |
| ❌ 不能写 | `status`、`video_path` 这类「生成结果」字段——写不进去，也伪造不出「已生成」 |
| ❌ 不会碰 | 生图 / 生视频 / 配音 / 配乐 / 导出成片（`/run`、`/stages`、`/regenerate`、`/music`、`/export`） |
| ❌ 没有 | 删除项目的接口（永远不提供） |

### 限制与注意

- **只对本机用**：技能默认只连 `127.0.0.1:4600`（Studio 后端为 `4610`，可用 `IC_BASE_URL` 指定）。这个实例**没有鉴权**——如果把 `config.json` 里的 `server.host` 改成 `0.0.0.0`，等于给局域网开了一个「能读全文、能改内容、能回滚」的入口，别这么配。
- **项目正在跑任务时先别写**：`GET /api/projects/:id` 的 `status` 是 `running` 就等它跑完（删除类写入会被直接拒 409；内容类写入也可能被任务用旧数据覆盖，最后成片和分镜表对不上）。
- **写进去的分镜要过业务校验**，否则接口直接 400：时长 1~15 秒；台词字数 ≤ 时长 × 5.5（超了会被压成听不清的模糊声）；单个分镜说话人 ≤ 2；分辨率 / 宽高比走固定枚举。
- **只走 HTTP API**：读写一律通过 `{base}/api/...`。不要直连 `data/ic.db`（只读也不行）、不要手改 `data/` 里的文件和 `config.json`——绕过去就没有变更日志，写错了回滚不了。
- **每一步都能回滚**：一次调用就是一个批次，可以单条、整批（`batch_id`）或按时间点回滚；回滚只恢复数据库里的内容，磁盘上的图片/视频文件不会跟着删（要重传）。
- **换机器照样用**：上面的命令都不依赖具体目录，在项目根目录执行即可；技能默认装到用户主目录 `~/.agents/skills/`。

细节见仓库根 [SKILL.md](../SKILL.md) 第六节（给 Agent 的完整契约）与 [writer-api-plan.md](./writer-api-plan.md)（设计取舍与逐轮记录）。

## 测试

```bash
pnpm test   # node --test tests/unit.test.mjs
```

## 说明与限制

- 视频逐镜串行生成（ComfyUI 单卡并发有限），单镜头数分钟级；整片耗时取决于镜头数与时长。
- H3 参考上限：图 ≤9、音视频 ≤3（超出自动报错）。
- 成片统一转码 H.264 + AAC（24fps），保证可播。
- 任务为后台持久化任务，刷新页面/重启服务后可续跑（幂等跳过已完成项）。
- 单视频任务超时默认 90 分钟（正常单镜远低于此，仅兜底），可在 config.json 的 `generation.videoTimeoutMinutes` 调整。
- 每 N 个生成任务自动调用一次 ComfyUI `/free` 释放显存（`generation.freeAfterEvery`，默认 3、0 = 关闭；兼容旧键 `videoFreeAfterEvery`），覆盖全部渲染、对抗 AMD Dynamic VRAM 连续生成后的速度退化；清理在下一个任务完成后生效，失败不影响产物。
- LLM 运行看门狗：模型输出被截断（`[Response truncated …]`）或上游停滞后，任务不再无限挂起——连续 3 次纯截断无进展、或 20 分钟无消息（工具渲染窗口不计入）会自动中止并标失败；慢速本地模型可调 `generation.agentStallMinutes`（默认 20）放宽无消息阈值。
