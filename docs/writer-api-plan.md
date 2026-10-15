# 外部写入 API + 可回滚日志 + harness Skill 方案

> 目标：让 harness（opencode 等外部 Agent）通过 HTTP API 把**新建项目 / 小说原文 / 剧本 / 分镜 / 上下文**写进一个正在运行的 infinite-creation 实例；所有内容写入都产生**可回滚日志**；日志**只在用户手动删除项目时**清除；**任何 API 都不得删除项目**。
>
> 范围硬约束（2026-10-15 补充）：
> - **本技能只写 LLM 文本**：小说、剧本、分镜、上下文、素材提示词。**禁止**调用任何生成/渲染/导出接口（`/run`、`/stages`、`/regenerate`、`/generate`、`/music`、`/export`、`/stop`）——图片、视频、语音、音乐、成片全部由用户在应用界面里启动。
> - **允许改写已生成的 LLM 产物**：整段覆盖已有章节的小说/剧本、逐条改已有分镜正文与 `video_prompt`、覆盖 `bible`/`style`、改素材提示词。产物字段（`status/error/video_path/video_prompt_used/prompt_id`）仍不可写。

---

## 一、现状盘点（已核对代码）

| 实体 | 表 / 关键字段 | 现有写入口 | 缺口 |
|------|---------------|-----------|------|
| 项目 | `projects`(name/novel/idea/style/video_*/target_duration/context/enable_bgm) | `POST /api/projects`、`PATCH /api/projects/:id`、`DELETE /api/projects/:id` | 无日志；`DELETE` 是唯一删项目入口 |
| 章节 | `chapters`(title/novel/seq/status/music_*) | `POST /api/projects/:id/chapters`、`PATCH|DELETE /…/chapters/:cid`、`PATCH /…/chapters`(排序) | **无「剧本」落点** |
| 分镜 | `shots`(idx/chapter/scene_name/camera/visual/dialogue/narration/sub_shots/duration/6×`*_ids`/refs/resolution/aspect_ratio/video_prompt/seed/status) | 仅 `GET /…/shots`；`PATCH /…/shots/:sid` **只接受 6 个 `*_ids`** | **分镜正文无法创建、无法写入** |
| 上下文 | `projects.context`(bible/style/continuity) | 只有 `GET /…/context`；写入靠 `PATCH /projects/:id` 整包覆盖 | 无专用写入端点，且不落 `context/*.md` |
| 资产/参考图 | `assets` / `reference_images` | `POST/PATCH/DELETE`（含上传） | 无日志 |
| 审计 | — | **不存在任何回滚/审计表**（`Projects.remove` 直接级联删 6 张表） | 全缺 |

其它既有事实：
- 服务**零鉴权**，默认只绑 `127.0.0.1`（`server.host` 可配 `0.0.0.0`）。
- 仓库内技能机制：`skills/<name>/SKILL.md`（frontmatter 仅 `name`/`description`）→ `scanSkills()` 入库，供**内置 Agent** 用；外部 harness 读 `~/.agents/skills/`。
- 已有同类先例 `calliope` skill：CLI 桥只写不删、`读 → 哈希 → 写 → 校验`。

## 二、内容分层映射（本方案的关键约定）

| 概念 | 落点 | 说明 |
|------|------|------|
| 新建项目 | `projects` | `POST /api/projects`（已有，补日志） |
| 小说原文 | `chapters.novel`（每章一段） | 与前端「章节原文」一致；`projects.novel` 仅作新建时的入参兼容 |
| **剧本** | **`chapters.script`（本次新增列）** | 小说 → 分镜之间的中间层；原本无处安放。与 `novel` 并列，不改动生成流水线语义 |
| 分镜 | `shots`（按章节聚合） | 本次补齐创建/正文写入/删除 |
| 人物圣经 / 风格 / 连续性 | `projects.context.{bible,style,continuity}` + `context/*.md` | 与内置 `save_context` 语义一致（新增 `PUT /…/context`） |

> 以上落点**同时用于改写已生成的 LLM 产物**（覆盖已有章节的 `novel`/`script`、逐条改分镜正文与 `video_prompt`、覆盖 `bible`/`style`、改素材提示词），这正是 harness 的常见用途。

> 流水线仍只读 `chapters.novel` 拆分镜，**`script` 是并行的可写产物**（可被外部写作流程消费，也可被人工/AI 直接生成分镜）。这样零风险，不改变既有生成行为。

## 三、可回滚日志设计

### 3.1 记录层：DB 层（覆盖全部写入方）

在 `lib/core/db.js` 的 5 张内容表增删改处埋点，因此**前端 UI、内置 LLM Agent、外部 harness 三方写入全部入库**。写入方通过 `AsyncLocalStorage` 传递来源：

- HTTP 路由：`writeContext('POST /api/…', fn)` → `source = 'POST /api/…'`、每个请求一个 `batch_id`
- 内置 Agent：在 `runTool()` 统一包一层 → `source = 'agent:<tool>'`
- 流水线/其它：默认 `source = 'internal'`

**不记录**：`jobs` / `messages` 等任务表；纯生成产物字段（`shots.status/error/video_path`）**会随整行快照一起被记录**，但可通过 `source` 过滤只看人工/API 写入。

### 3.2 表结构

```sql
CREATE TABLE IF NOT EXISTS change_logs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  batch_id    TEXT DEFAULT '',   -- 同一次 API 调用 / 同一次工具调用
  ts          INTEGER NOT NULL,
  source      TEXT DEFAULT '',   -- 'POST /api/projects/:id/shots' | 'agent:create_shot' | 'internal'
  entity      TEXT NOT NULL,     -- project|chapter|shot|asset|reference
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,     -- create|update|delete|rollback
  before      TEXT,              -- 原始行快照 JSON（null = 该操作前不存在）
  after       TEXT,              -- 原始行快照 JSON（null = 该操作后不存在）
  revert_of   TEXT DEFAULT '',   -- action=rollback 时指向被回滚的原始日志 id
  reverted_by TEXT DEFAULT '',   -- 已被哪条回滚日志抵消
  meta        TEXT DEFAULT '{}'  -- 附带信息（如章节改名时迁移的分镜 id 列表）
);
CREATE INDEX IF NOT EXISTS idx_change_logs_project ON change_logs(project_id, ts);
```

快照存**原始 DB 行**（不经过 `toXxx` 的 JSON 解析），回滚时可直接 `INSERT OR REPLACE` 复原，避免字段映射漂移。

### 3.3 回滚语义

| 原操作 | 回滚动作 |
|--------|----------|
| `create` | 删除该行；若实体是 `chapter`，同时删除 `chapter=<title>` 的分镜（与 `Chapters.remove` 一致） |
| `update` | 用 `before` 快照覆盖整行 |
| `delete` | 用 `before` 快照原 id 重建 |
| `rollback` | 再回滚 = **重做**（保留可逆性） |

- **漂移保护**：执行前比对「当前行」与日志 `after`；不一致 → `409` 并给出冲突详情，`force=true` 才强制覆盖。
- **批次回滚**：`batch_id` 内按 `ts` 倒序逐条应用；中途失败**中止并如实报告已应用条数**（不静默成功）。
- **禁止删项目**：`entity=project && action=create` 的回滚**直接拒绝**（否则等于删项目），返回提示「请在界面手动删除项目」。
- 回滚自身也写一条 `action='rollback'` 日志，并给原日志打 `reverted_by` —— 每一次撤销都可审计、可重做。
- **只恢复 DB 行，不删磁盘媒体文件**（避免误删）；章节删除回滚不恢复 `posters/*.jpg`（已知限制，见 §七）。

### 3.4 保留策略

`Projects.remove(id)` 增加 `DELETE FROM change_logs WHERE project_id=?`。
除「用户手动删除项目」外**不自动清理**（符合需求）。

## 四、API 清单

### 4.1 新增

| 方法 | 路径 | 作用 |
|------|------|------|
| `PUT` | `/api/projects/:id/context` | 写 `bible` / `style` / `continuity`（同步 `context/*.md`） |
| `POST` | `/api/projects/:id/shots` | 创建单个分镜 |
| `DELETE` | `/api/projects/:id/shots/:sid` | 删除单个分镜 |
| `PUT` | `/api/projects/:id/chapters/:cid/storyboard` | 整章分镜批量写入（`{shots:[…], replace:true}`，一次调用一个批次） |
| `GET` | `/api/projects/:id/logs` | 列日志（`entity`/`action`/`source`/`limit`/`offset` 过滤） |
| `POST` | `/api/projects/:id/logs/rollback` | 回滚：`{log_id}` 单条 / `{batch_id}` 整批 / `{since_ts}` 该时刻之后全部；`force` 跳过漂移保护 |

### 4.2 扩展

| 方法 | 路径 | 变更 |
|------|------|------|
| `PATCH` | `/api/projects/:id/shots/:sid` | 除 6 个 `*_ids` 外，接受分镜正文字段：`chapter/idx/scene_name/camera/visual/dialogue/narration/sub_shots/duration/references/resolution/aspect_ratio/video_prompt/seed/parent_shot_id`（**不接受** `status/error/video_path/video_prompt_used`，防伪造生成结果） |
| `PATCH` | `/api/projects/:id/chapters/:cid` | 新增 `script` 字段 |
| `POST` | `/api/projects/:id/chapters` | `script` 可选 |
| 全部内容写路由 | 项目/章节/分镜/资产/参考图 | 统一包 `writeContext(...)`，写日志 |

### 4.3 明确不提供 / 禁止

- **不提供任何删除项目的 API**（现有 `DELETE /api/projects/:id` 仅供前端界面使用，不进 skill；回滚也拒绝删项目）。
- **不提供任何生成接口的封装**：skill 禁止调用 `/run`、`/stages`、`/stop`、`/shots/:sid/regenerate`、`/chapters/:cid/regenerate`、`/assets/:aid/generate|design-voice|change-outfit|change-age`、`/music`、`/music/apply`、`/export`。本技能的存在意义就是「把文本写进去」，生成始终由用户在界面触发。
- 不允许外部写 `status/error/video_path/video_prompt_used/prompt_id` 等流水线产物字段（`pickShotFields` 直接 400，防伪造「已生成」）。

## 五、harness Skill 设计

- 仓库内：`skills/ic-writer/SKILL.md`（版本化、可 diff）。
- 安装：`node scripts/install-writer-skill.mjs` → 复制到 `~/.agents/skills/ic-writer/`（opencode 自动发现；新技能需重启会话）。
- 内容要点：
  1. 前置：`IC_BASE_URL`（默认 `http://127.0.0.1:4600`）+ `GET /api/health` 探活；
  2. **铁律**：不得删除项目；先读后写（GET → 写 → 回读校验）；长文本必须走 JSON 文件（`--data-binary @file.json`）而非命令行内联；分镜按章节整体写；
  3. 端点速查表（方法 / 路径 / body 示例 / 返回）；
  4. 「剧本 → 分镜」的字段约定（对齐 `story-pipeline-cn` 的长镜头聚合）；
  5. 回滚用法（列日志 → 单条 / 整批回滚）；
  6. 交付前校验清单。

## 六、实施分期

| 期 | 内容 |
|----|------|
| P0 | `chapters.script` 迁移；`change_logs` 表 + `Projects.remove` 级联；`lib/core/changelog.js`（记录/查询/回滚引擎）；db.js 五表埋点；新增/扩展路由；`writeContext` 接入 |
| P1 | `skills/ic-writer/SKILL.md` + 安装脚本；根 `SKILL.md` 增补「外部写入 API」章节；安装到 `~/.agents/skills/` |
| P2（本轮不做） | 可选写入 token（`IC_WRITE_TOKEN`）、`expect_hash` 乐观锁、日志保留上限、前端 UI 展示剧本/日志页 |

## 七、已知限制与不做的事

- 回滚只复原 DB 行，**不删除已生成的图片/视频/音频文件**（避免误删用户素材）；如需彻底清理请手动删文件。
- 回滚章节删除**不恢复**其 `posters/*.jpg` 首帧缓存（下次生成会重建）。
- 单条回滚是「按快照覆盖」，若之后有新增字段变更会被 `force` 一并覆盖 —— 默认拒绝（漂移保护）已兜底。
- 不改动任何生成流水线语义（`script` 仅新增、不被流水线隐式消费）。

## 八、验收

端到端脚本（`tests/changelog.test.mjs` 用临时 `IC_DATA_DIR`，不污染 `data/ic.db`）：

```
建项目 → 写 3 章小说 → 写剧本(script) → 写整章分镜 → 列日志
→ 回滚单条分镜 → 回读校验 → 回滚整批 → 回读校验
→ 漂流场景：写后手改再回滚旧日志 → 期望 409；force=true → 成功
→ 回滚「项目创建」日志 → 期望拒绝
→ 删除项目 → 期望 change_logs 清空
```

`node --check` 全通过、`node --test tests/` 全绿。
