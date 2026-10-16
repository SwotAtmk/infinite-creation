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

**不记录**：`jobs` / `messages` 等任务表；以及 `update` 只动了产物/易变字段（`shots.status|error|video_path|video_prompt_used|prompt_id`、`chapters.music_path|music_prompt_used`、`assets.image_path|status|…`）的情形——这类变更**整条不写日志**，否则每跑一轮渲染都会为每条分镜刷出成批噪音、把内容日志彻底淹掉。它们只在别的内容变更的整行快照里作为上下文出现。

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
- **批次回滚**：`batch_id` 内按 `ts` 倒序逐条应用；逆操作整批跑在**一个事务**里，中途失败 → 全部撤销，返回 `applied: []` + `rolled_back: true`（不静默成功、也不留「改了一半」）。
- **单条 vs 整批**：`log_id` 只恢复那一条；级联删除（如删章节连带删的分镜）各有自己的日志，要「整个操作一起还原」必须用那次的 `batch_id`。
- **`since_ts` 不反转回滚日志**：窗口内 `action='rollback'` 的日志被 SQL 排除——否则「撤销 T 之后的东西」会顺手把此前的回滚反转成重做。要重做请显式回滚那条 `rollback` 日志。
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
| `PATCH` | `/api/projects/:id/shots/:sid` | 除 6 个 `*_ids` 外，接受分镜正文字段：`chapter/idx/scene_name/camera/visual/dialogue/narration/sub_shots/duration/references/resolution/aspect_ratio/video_prompt`（**不接受** `status/error/video_path/video_prompt_used/seed`，防伪造生成结果；`seed` 见 §二十）。数组字段的元素必须是字符串：塞对象当场 400，不再静默存 `"[object Object]"`。写入前过一遍业务校验：`duration` 1~15 秒、`dialogue` ≤ duration×5.5 字、单镜说话人 ≤2、`resolution`/`aspect_ratio` 走枚举；**跨字段校验只在本次真的改了它依赖的字段时做**（见 §二十一 修复 2） |
| `PATCH` | `/api/projects/:id/chapters/:cid` | 新增 `script` 字段 |
| `POST` | `/api/projects/:id/chapters` | `script` 可选 |
| `POST` | `/api/projects`、`PATCH` `/api/projects/:id` | 新增项目级校验：`video_resolution`/`video_aspect_ratio` 走 `lib/shared` 同一份枚举（空串 = 默认 `480P`/`16:9`），非法值 400。分镜生成时取 `shot.resolution \|\| project.video_resolution`，项目这一层写错会让整个项目在渲染阶段才炸 |
| 全部内容写路由 | 项目/章节/分镜/资产/参考图 | 统一包 `writeContext(...)`，写日志 |

### 4.3 明确不提供 / 禁止

- **不提供任何删除项目的 API**（现有 `DELETE /api/projects/:id` 仅供前端界面使用，不进 skill；回滚也拒绝删项目）。
- **不提供任何生成接口的封装**：skill 禁止调用 `/run`、`/stages`、`/stop`、`/shots/:sid/regenerate`、`/chapters/:cid/regenerate`、`/assets/:aid/generate|design-voice|change-outfit|change-age`、`/music`、`/music/apply`、`/export`。本技能的存在意义就是「把文本写进去」，生成始终由用户在界面触发。
- 不允许外部写 `status/error/video_path/video_prompt_used/prompt_id` 等流水线产物字段（`pickShotFields` 直接 400，防伪造「已生成」）。
- 项目正在跑任务（`activeJobOf`）时，**删除类写入一律 409**：`DELETE …/chapters/:cid`、`DELETE …/shots/:sid`、`PUT …/chapters/:cid/storyboard`。

## 五、harness Skill 设计

- 仓库内：`harness-skills/ic-writer/SKILL.md`（版本化、可 diff）。
- **为什么不放 `skills/`**：`skills/` 会被 `scanSkills()` 注册进**应用内** Agent 的技能目录，教会它用 HTTP 调自己的 API 没有意义（它本来就有领域工具），纯属噪音；所以技能源放在不被扫描的 `harness-skills/`，由安装脚本同步给外部 harness。
- 安装：`node scripts/install-writer-skill.mjs` → 复制到 `~/.agents/skills/ic-writer/`（opencode 自动发现；新技能需重启会话）。
- 内容要点：
  1. 前置：`IC_BASE_URL`（默认 `http://127.0.0.1:4600`）+ `GET /api/health` 探活；
  2. **铁律**：不得删除项目；**只能走 HTTP API 读写**（禁止直连 `data/ic.db` 或手改 `data/`、`config.json`——绕过去就没有变更日志，不可回滚且 `source`/`batch_id` 记不上）；先读后写（GET → 写 → 回读校验）；长文本必须走 JSON 文件（`--data-binary @file.json`）而非命令行内联；分镜按章节整体写；
  3. 端点速查表（方法 / 路径 / body 示例 / 返回）；
  4. 「剧本 → 分镜」的字段约定（对齐 `story-pipeline-cn` 的长镜头聚合）；
  5. 回滚用法（列日志 → 单条 / 整批回滚）；
  6. 交付前校验清单。

## 六、实施分期

| 期 | 内容 |
|----|------|
| P0 | `chapters.script` 迁移；`change_logs` 表 + `Projects.remove` 级联；`lib/core/changelog.js`（记录/查询/回滚引擎）；db.js 五表埋点；新增/扩展路由；`writeContext` 接入 |
| P1 | `harness-skills/ic-writer/SKILL.md` + 安装脚本；根 `SKILL.md` 增补「外部写入 API」章节；安装到 `~/.agents/skills/` |
| P2（本轮不做） | 可选写入 token（`IC_WRITE_TOKEN`）、`expect_hash` 乐观锁、日志保留上限、前端 UI 展示剧本/日志页 |

## 七、已知限制与不做的事

- 回滚只复原 DB 行，**不删除已生成的图片/视频/音频文件**（避免误删用户素材）；如需彻底清理请手动删文件。
- 回滚章节删除**不恢复**其 `posters/*.jpg` 首帧缓存（下次生成会重建）。
- 单条回滚是「按快照覆盖」，若之后有新增字段变更会被 `force` 一并覆盖 —— 默认拒绝（漂移保护）已兜底。
- **单条 `log_id` 回滚不连带恢复级联子项**：删章节带回分镜；只回滚章节那条日志时，分镜要各自按它们的日志恢复，或者按「这次回滚自己的 `batch_id`」整批重做（级联删分镜会逐条留 `delete` 日志，落在该回滚批次里）。
- **章节标题改为「同项目内唯一」**：既有库里若有历史重名章节，不会被自动改名/合并（需要人工处理），但此后任何新写入的重名都会被 400 拒绝。
- **运行中的项目拒绝删除类写入**（删章节 / 删分镜 / 整章替换分镜）→ 409，`running` 与 `queued`（排队等视频槽位）都算运行中：任务持有这些行，删掉只会让它的回写静默落空。内容类 PATCH 不拦（代价是任务可能用旧数据出片，属可接受）。
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

`node --check` 全通过、`node --test "tests/*.test.mjs"` 全绿（Node ≥22 的 glob 形式；写成 `node --test tests/` 在 Node 24 下会 MODULE_NOT_FOUND）。

## 九、审计修复记录（2026-10-15，dev7 复审后）

对 P0/P1 落地代码逐文件复审（含业务逻辑与流水线交互），修掉以下问题：

| 级别 | 问题 | 修复 |
|------|------|------|
| 高 | `PUT …/storyboard` 在 `replace:false` 时镜号从 1 重新编号，与既有分镜撞号（`assemble_video` 排序不确定） | 追加模式从该章现有最大 `idx` 往后接；同一批内重复 `idx` 直接 400 |
| 高 | 「分镜归属 = 章节标题」但标题不唯一：重名章共用分镜、删一章连带删另一章的镜头 | `Chapters.create/update` 强制同项目标题唯一（trim 后比较），路由翻成 400 |
| 高 | 外部写入绕过应用自身的分镜业务约束（时长/台词速度/说话人数/分辨率枚举） | 校验下沉到 `lib/core/shot-write.js`（`pickShotFields` + `validateShotContent`），两条 shot 路由与整章写入全部接入；Agent 侧常量改为引用同一份 |
| 高 | `since_ts` 回滚会把此前的回滚一并反转（= 悄悄重做） | `since_ts` 分支加 `AND action <> 'rollback'` |
| 高 | 批量写入/回滚无事务：中途失败留半吊子状态，且承诺的「报告已应用条数」并未实现 | `db.tx()`（含嵌套深度判断）包住整章写入、回滚循环、章节改名级联、章节/资产/项目删除；回滚失败整体撤销并如实返回 `applied: []` |
| 中 | `ic-writer` 被 `scanSkills()` 注册成应用内 Agent 的技能（噪音） | 技能源移到 `harness-skills/`，安装脚本与文档同步 |
| 中 | 内容写入与「运行中的任务」无协调，删掉运行中任务持有的行只会静默落空 | 删除类写入（删章节/删分镜/整章替换）在 `activeJobOf` 时返回 409；技能里加了「先看 `status` 再写」 |
| 中 | 部分内容写路径未包 `writeContext` → 日志 `source='internal'`、`batch_id=''`，无法整批定位 | 章节「重新生成分镜」的 `beforeRun`、`music` 路由的资产写入补上写上下文 |
| 中 | `Shots.create` 自动镜号是项目级 `MAX(idx)+1`，与「每章独立镜号空间」的约定不一致 | 改为按章取 `MAX(idx)+1` |
| 低 | `parent_shot_id` 在可写白名单里但全仓库无人读取（无效字段） | 从白名单移除（列保留，不影响老数据） |
| 低 | §3.1/§3.3/§八 的表述与实现不一致 | 本文档已按实现改正 |
| 低 | 分辨率取值域三处各写一份：界面下拉 `360P/480P/720P/768P/custom`、工作流映射表 `480P/720P/1080P/2K/4K`、写入白名单（两者并集）。`360P`/`768P` 在映射表里没有条目 → 标签被原样写进 `megapixels`，提交才报错；`1080P`/`2K`/`4K` 在下拉里根本选不到 | 统一到 `lib/shared/index.js`：`VIDEO_RESOLUTION_MP`（补 360P/768P）、`VIDEO_RESOLUTION_OPTIONS`（下拉）、`VIDEO_RESOLUTIONS`/`VIDEO_ASPECT_RATIOS`（校验）。新增一致性回归盯着「映射表键 = 共享常量键」 |
| 低 | 音乐工作流描述写「本地英伟达原版」，实际引用 `minimax_music3_dit_int8_convrot.safetensors`（fp16 只出现在云端 `workflows/RunningHub/`） | 描述改为「本地工作流，DiT int8 量化版」/「云端 fp16」 |
| 低 | 「合成整片」（`assemble_video` 不带 `chapter`、`POST …/export` 不带 `chapter`）按全局 `idx` 排序，多章项目会交叉成「第1章第1镜、第2章第1镜…」 | 新增 `Shots.listInNarrativeOrder`（章节 `seq` → 章内 `idx`），两条合并路径改用 |
| 低 | `pnpm run install:ic-writer` 别名缺失 | 回补到 `package.json` |
| 中 | 项目级 `video_resolution` / `video_aspect_ratio` 无校验：`PATCH /api/projects/:id` 把 body 直通 `Projects.update`，`{"video_resolution":"banana"}` 返回 200。而生成时取 `shot.resolution \|\| project.video_resolution`，**一处脏写让整个项目的每一镜都在渲染阶段才炸** | 校验下沉到 `lib/core/db.js` 的 `Projects.create/update`（复用 `lib/shared` 的 `VIDEO_RESOLUTIONS`/`VIDEO_ASPECT_RATIOS`），两条项目路由翻 400；`update` 只校验本次要写的键，存量行里的历史脏值不会让「改个名字」也失败 |

### 复核对齐结论

- 「本地/云端」与「int8/fp16」是两件事：本地 `audio_minimax_music_3.json` 与云端 `RunningHub/audio_minimax_music_3.json` 的 DiT 权重不同（int8 convrot / fp16），文生图与视频工作流同理（映射表按 `hardware.mode` 选，云端固定走 RunningHub）。描述里只写「英伟达」会让人误以为是模型版本。
- 分辨率标签的上游已核对清楚（不再是推测）：`ResolutionSelector` 是 **ComfyUI 核心节点**（`comfy_extras/nodes_resolution.py`），`megapixels` 为 Float、只有 `min=0.1`/`max=16` 的范围校验（`execution.py` 的 `validate_inputs` 只查 min/max，**不查 step**）、`aspect_ratio` 的 8 个选项与本文档的共享列表逐字相同；映射表由 `ComfyUI_MiniMaxH3_Director` 的 `resolution_from_selector`（面积 → 按宽高比折算 → 宽高取 32 的倍数、下限夹到 16 MP）消费。
- 因此 `1080P`/`2K`/`4K` 是**合法入参**（`2`/`4` 在 0.1~16 内），留在映射表里、不进下拉是**成本**取舍而非「选了就报错」：2 MP/4 MP 就是 1080p/4K 级出片，AMD 单卡上不现实（作者原下拉本来也止于 `768P`）。
- 顺带核对到：英伟达原版视频路径的 `MiniMaxH3Easy` 节点在本机 **ComfyUI 里不存在**（核心 `comfy_extras/nodes_minimax_h3.py` 只有 `MiniMaxH3ImageToVideo`/`AddGuide`/`ReferenceToVideo`/`SigmaShift`，第三方包只注册 `MiniMaxH3Director*`），`workflows/MiniMax_H3_Easy_r2v.json` 在本机跑不起来——本机视频只走 GGUF 那条（`minimax_h3_r2v_gguf`），即 `resolution` 只会经上面的 megapixels 映射表。
- 实例仍然零鉴权：默认只绑 `127.0.0.1`；改成 `0.0.0.0` 等于把「读全文 / 改内容 / 回滚」端点开给整个局域网，技能里已写明只对本机用。

## 十、第二轮审计修复记录（2026-10-16，dev7 复审后）

第二轮专盯「外部写入 API 的字段边界 / 可回滚日志的完整性 / 与流水线状态的协调」，逐条读源码核验后修掉以下问题（每条一个提交，回归测试随修复走）：

| 级别 | 问题 | 修复 |
|------|------|------|
| 高 | 章节 `PATCH …/chapters/:cid` 把请求体直通 `Chapters.update`：可写 `seq`（绕开 `reorder` 的撞号保护 → 成片顺序不确定）、`status`/`music_path`/`music_prompt*`（伪造状态、写流水线产物）；拼错字段（`titel`）被静默忽略却回 200 | 新增 `CHAPTER_STRING_FIELDS` / `pickChapterFields`，只认 `title`/`novel`/`script`，其余当场 400 |
| 高 | 章内镜号唯一只在「同一次请求」内校验：`POST …/shots` 显式给 `idx`、`PATCH …/shots/:sid` 改 `idx`、`PUT …/storyboard` 带 `replace:false` 追加，都能与库里已有行撞号 | 新增 `idxTakenBy(shots, chapter, idx, excludeId)`，三条写入口共用；冲突 400 并提示「省略 `idx` 自动续号」 |
| 高 | 「素材库 → 参考」用途切换直接 `Assets.remove(asset_id)`：级联删掉该素材（角色连服装/年龄变体一起没），分镜上的 `character_ids`/`costume_ids` 引用静默失效（参考图少一张、`__MINIMAX_H3_REF_N__` 编号错位） | 切换前用新增的 `Assets.usageOf(id)`（子变体数 + 引用它的分镜）检查，在用即 400 并说明「几个变体会被删 / 被几个分镜引用」 |
| 高 | 回滚「章节新建」时对分镜做裸 `DELETE`：审计断链（看不到分镜被一起删），且「回滚这次回滚」只恢复章节、分镜永久丢失 | 级联删前逐条 `recordChange(action:'delete', before: 原行)`（`meta.cascade='chapter-rollback'`）；这些日志落在本次回滚批次，重做可把章节与分镜一起恢复 |
| 中 | `activeJobOf` 只认 `status='running'`：排队中（`queued`）的任务不算活跃，`POST /run`、`POST /stages` 的防重与删章节/删分镜/整章替换的 409 守卫在排队期间全部失效 | 改为 `running \|\| queued`（`job-runner` 内部、`jobs` 路由、`cancel` 路由本来就都算活跃） |
| 中 | `PATCH …/shots/:sid` 传 `{chapter:""}` 会把分镜变成谁也看不见的孤儿行：章节视图与 `chapterStats` 按标题归属（统计里消失），整片导出却仍会合进去 | `validateShotContent` 拒绝显式空 `chapter`（省略 = 不改归属）；`POST …/shots` 把归属解析挪到内容校验之前，空串仍按文档落第一章 |
| 中 | `GET …/logs` 的 `total` 无视 `entity`/`action`/`source` 筛选（`countChanges` 不带筛选）：按 `total` 翻页会翻出空页 | 抽出 `changeWhere()`，`listChanges` 与 `countChanges` 同口径；路由把筛选条件传两处 |
| 中 | 回滚不存在的 `log_id`/`batch_id` 返回 200 空结果 —— 调用方以为「回滚已生效」 | 显式目标查不到即抛 `BAD_TARGET`（路由 400）；`since_ts` 空窗口仍是合法空结果 |
| 低 | `force` 回滚「行已不存在」的日志时 `recordChange` 拿不到 `project_id` 返回 null：不留审计记录、`reverted_by` 空、之后的全量回滚会把它再撤一次 | `recordChange` 增加 `projectId` 兜底参数，`rollbackLogs` 传 `log.project_id` |
| 低 | `set_storyboard` 的分镜字段拼错（`sence_name`、`cast`）被静默丢弃，回报却是「分镜已写入」 | 新增 `SHOT_INPUT_KEYS` 嵌套白名单，拼错当场报错并列出可用字段 |
| 低 | `seed` 不在易变字段里：`generateShotVideo` 每次渲染随机重写 → 每镜刷一条整行 `update` 日志淹掉内容日志，并让「harness 写完 → 应用渲染一轮」后的内容回滚被误判漂移（要 `force`） | `VOLATILE.shot` 加入 `seed` |

### 本轮复核过、判定「不改」的项

- **`set_storyboard` 的 clear + 逐条写入不再包 `tx()`**：所有校验（台词速率、说话人数、章节解析、`idx` 归一）都在 clear 之前整批完成，循环内无可达抛错路径（`Shots.update` 已用 monkey-patch 验过时序），属纯防御性硬化。
- **`custom` 分辨率 + 宽高为空 → 1024×576**：这正是界面 `placeholder="1024"/"576"` 的兜底语义，有意为之。
- **同名资产 `byName` 取最新**：`assets` 表无 `(project_id, name)` 唯一约束（只有章节有），重名是既有设计。
- **`pendingByStage` 的 tts 计数**与 `hGenerateAssetsBatch` 的跳过条件逐字一致（`无 voice_desc 的角色永远待办`是真待办信号）。
- **`DELETE …/references/:rid` 仍会连带删掉关联素材**：这是用户显式删除参考素材的动作（且参考图文件本就是真 `unlink`），与「下拉框换个用途就悄悄删」不同类；级联语义保留，文档化即可。
- **产物文件部分失败留孤儿文件**：属生成阶段的清理问题，与本 API 的写入边界无关。

两轮验证口径：`node --test "tests/*.test.mjs"` **113/113**；真实实例端到端脚本 **88/88**（含本轮新增的镜号撞号、空 `chapter`、章节排序完整性等）；另有针对「素材用途切换」守卫的独立端到端 **10/10**。

## 十一、第三轮审计修复记录（2026-10-16，dev7 复审后）

第三轮把范围扩到「`lib/agent` 工具面 + `lib/core` 非写路径 + 全部路由 + 路径/网络边界」，逐条读源码核验后修掉以下问题（每条一个提交，回归测试随修复走）：

| 级别 | 问题 | 修复 |
|------|------|------|
| 高 | `set_storyboard` 的 `clear=true` 清的是**整个项目**的分镜，而工具语义是「按 `idx` 重写本次写入的章节」：重写第 2 章会连带删掉第 1 章已出片的镜头，回报仍是「分镜已写入」 | 只清本次写入涉及的章节（`clearTitles` 集合），schema 里写明范围 |
| 高 | 同一批里「省略 `idx` 的镜头 + 显式 `idx` 的镜头」单遍分配会撞号（`[无 idx, idx:1]` → `[1,1]`），后一条走 upsert 覆盖前一条，内容被静默丢掉 | 两遍分配：先统计全部显式 `idx` 得出各章上限，再给省略的续号；新建行登记回 `byKey` |
| 高 | 换装/年龄兜底挂在 `set_storyboard` 里，于是「只写分镜」的 LLM 阶段也会真去图生图：该阶段 ComfyUI 通常没启动，每次都白等一次超时 | LLM 阶段（`renderDisabled`）只检测并回报待处理数，真正的生成与绑定移到「资产图」阶段（`stages.js` 调 `resolveShotProvisions`） |
| 高 | `PATCH /api/projects/:id` 整体透传给 `Projects.update`：可写 `status`（伪装流水线状态，前端「运行中」判定与 `/run`、`/stages` 都读它）、`context`（绕过 `PUT /context` → DB 与盘上 `context/*.md` 脱节） | 白名单化（`pickProjectFields`），只认内容字段 |
| 高 | 章节 `title` 写成空串：分镜按标题归属，整章分镜从章节视图与 `chapterStats` 里消失（成片仍算进去），空标题还会绕过标题唯一性检查 | `pickChapterFields` 与 `Chapters.update` 双层拒绝空标题（400） |
| 中 | `narration`（旁白）是 shots 正文列、外部写入 API 一直收，但内置 Agent 的 `set_storyboard`/`update_shot` 既不在输入白名单也不在补丁白名单：模型按系统提示写旁白会被整批拒绝或静默丢弃 | 两处白名单 + 两个 schema 属性都补上 `narration` |
| 中 | 资产名对不上（拼错、资产还没建）时静默丢弃：分镜照建、参考屏蔽，回报却是「分镜已写入」 | 收集未命中的名字随结果回报（不拒绝整批：模型可先建资产再回填） |
| 中 | 兜底失败（图生图报错）只写进 `notes` 且从不使用：服装没生成、镜头继续用原图出片，模型看不到 | 失败信息随结果文本回报 |
| 中 | 参考图 `chapter_id` 可为空串/别的项目的章节：这条参考图在章节视图与生成上下文里都筛不到，不报错也不参与生成（「看不见的脏数据」） | 必填且必须属于本项目（400/404）；UI 两处上传点本来就传第 1 章/当前章，db 里也有把空值归入第 1 章的迁移，方向一致 |
| 中 | 素材 `category` 不在值域：素材库按 `category` 过滤，脏分类的行界面里看不见、批量生成与统计也扫不到 | `Assets.create` 做最后一道 + 素材创建/参考图转素材路由在其前拒绝（400） |
| 中 | 参考素材上传写死 ComfyUI 的本机上传接口：渲染后端选 RunningHub 时工作流在云端跑，本机文件名在云端不存在 → 参考图整批失效 | 改走 `backend.js` 分派层；RunningHub 上传缺 `fileName` 直接报错（原先把 `undefined` 当文件名往下传） |
| 中 | ComfyUI `ws` 建连在 `try` 内、`queuePrompt` 在 `try` 外：提交/校验失败一抛错就没人关这条连接；上层对同一分镜还会重试多次，泄漏线性累积 | 失败路径关闭 `ws` |
| 中 | 技能 zip 安装只拦「精确等于 `..`」的分量：Win32 会剥掉路径分量结尾的点与空格，`a/.../x` 里的 `...` 会被文件系统当 `..` 解析 → 只拦精确形态等于越界写 | 拒绝全点分量与以点/空格结尾的分量，并加 `path.relative` 包含性兜底 |
| 中 | `guard` 的路径穿越检查只看 POSIX 形态（`../` 与前导 `/`），而运行平台是 win32：`C:\Windows\win.ini`、`C:../x` 不会被拦 | 覆盖 Windows 绝对路径与盘符相对路径 |
| 低 | 音乐资产按「章标题 + 固定命名」新建：重复生成同一章不断堆同名条目 | 同名（同项目同分类）原地更新 |
| 低 | `apply_chapter_music` 逐章合并，任一章抛错（例如视频文件缺失）整个工具中断，后面的章节连碰都没碰 | 逐章 `try/catch`，失败写进该章结果继续 |
| 低 | 资产上传的 `X-Filename` 由客户端 `encodeURIComponent` 后发送，非法转义让 `decodeURIComponent` 抛 `URIError` → 未捕获异常、500，看不出是文件名的问题 | `try/catch` → 400 |
| 低 | 渲染次数计数器是模块级变量：Next dev 下同一模块可能被加载多份，计数各算各的，「连续渲染 N 次后释放显存」的触发时机飘 | 挂到 `globalThis` |

### 本轮复核过、判定「不改」的项

- **`withRetry`（`lib/app`）无调用点**：死代码，删了也不影响行为；留着等后续接重试，本轮不动（避免与「不改业务语义」混淆）。
- **`abortFlags` 只增不减**：`AbortController` 的标记集合按 job 维度增长，进程内不回收；单个实例的任务量级下不构成泄漏，且清早了会误判中止。
- **`PUT /api/config` 整体覆盖**：这是 PUT 语义（整体替换），界面本来就读全量再写回；改成分部合并反而让「删掉一个字段」做不到。
- **`assets/upload` 的大小上限**：无上游依据（视频上传同样走这条路），加限制会破坏视频上传，保留现状。
- **`installSkillsFromZip` 中途失败不回滚**：已装好的文件留在 `skills/` 里不参与状态、重装即覆盖；回滚反而可能删掉用户手放的技能目录。
- **`GET …/shots/zip` 空集返回 500**：上游（导出入口）不会对空项目发起，且 500 比空 zip 更能暴露状态异常。
- **`mergeVideos` 的 `volume`**：两处调用点都传内部常量 `0.25`，不可达。
- **`POST …/music/apply` 路由层不校验 `music_id`**：handler 内已有校验，路由再查一遍属重复。
- **章节/分镜 `PATCH` 无 `activeJobOf` 守卫**：内容类写入不打断运行中的任务（与「删除类才拦」的既定口径一致）。
- **`shots/zip` / `export` 缺 `Projects.get`**：项目不存在时下游查询返回空集，路径上不可达（且必须落盘才可能越界）。

第三轮验证口径：`node --test "tests/*.test.mjs"` **126/126**（本轮新增/改写 14 项）；反向验证（`git stash` 掉 `app/api`+`lib` 只留新测试）**14 项全部命中失败**、其余 112 项照常通过（零回归）；真实实例端到端 **88/88**，素材用途守卫端到端 **15/15**（本轮新增「缺 `chapter_id` / 外项目 `chapter_id` / 分类越界 → 400/404 且不落盘」三条）。

## 十二、第四轮（确认轮）补齐

第三轮收尾时按「同一类问题只在一处挡了」的线索回头复查，抓到两处同类的漏网（都是本轮新加校验没覆盖到的兄弟入口）：

| 级别 | 问题 | 修复 |
|------|------|------|
| 中 | 分类值域只挡在 `Assets.create`，而 `PATCH …/assets/:aid` 的可编辑字段里有 `category`：等于留了「先把行建出来、再改成脏分类」的后门，界面分组与批量生成照样扫不到 | `Assets.update` 补上同一道守卫；路由把 `BAD_ASSET_CATEGORY` 翻成 400（原先抛到框架层变 500） |
| 低 | `POST …/chapters` 把请求体整包丢给 `Chapters.create`：拼错的字段（`titel`/`noval`）被静默忽略却回 200，调用方以为写进去了；显式空白标题会落成一章「界面上没有名字」的章节，而 PATCH 侧本就拒绝空标题（建得出来、却再也存不下去） | 创建路由改用 `pickChapterFields`（只认 `title/novel/script`，其余 400）；`Chapters.create` 把空白标题兜底成「第N章」 |

### 本轮核对过、判定「不改」的项

- **资产名为空**：界面里是一行「没有标题」的素材，但素材的可见性由 `category` 过滤决定（`Assets.list` 只按分类过滤），属观感问题；`POST /assets` 路由与 `create_asset` 工具的 schema 都已要求 `name`，db 层再拦会连带影响内部流程（音色/音乐资产的名字由上游拼出），不加。
- **`Chapters.create` 不改存储内容**：带前后空格的标题照旧原样落库（只处理纯空白这一种），因为分镜按 `title` 精确归属，写时归一化会让「已有分镜 + 新标题」脱节。
- **UI 调用点全量核对**：`EditProject` 的 PATCH 字段全在白名单内；`ChaptersView` 的参考上传带 `chapter_id`、新增章节发 `{}`；`AssetsTab` 的资产表单与 `ReferencePicker` 的分类下拉取值都在 `ASSET_CATEGORY_IDS` 内（只少一个 `age`，那是换装/年龄流程生成的，不可手选）；`ShotsTab` 只 PATCH 素材绑定字段。第三轮的收紧没有误伤界面。

第四轮验证口径：`node --test "tests/*.test.mjs"` **126/126**（两处修复各扩写一个既有测试）；真实实例端到端 **88/88**、素材用途守卫 **15/15** 保持不变，另加两条实机探针 **各 6/6**（`PATCH` 分类越界/空 → 400 且分类未变、合法值照常；`POST` 章节拼错字段/空白标题 → 400、省略标题自动「第N章」、重名带尾空格仍 400）。

## 十三、第五轮：越过「外部写入 API」，把两侧未深审的模块一起过一遍

第四轮之后 API 面（路由 + `lib/core/shot-write.js`）已经查得很细，于是把范围推到两侧：一侧是 `lib/agent/*`（job-runner / agent-loop / openclaude-agent / stages / guard）与 `lib/core` 剩余模块（ffmpeg / logger / config / llm / changelog / backend / prompts / utils）+ `lib/ws.js`；另一侧是界面（`app/pages/*`、`api-client`、`toast`）与尚未细看的路由（jobs / logs / exports / music-apply / config / skills / comfyui-test / llm-test / health / run / shots）。两条线并行审、逐条回到源码核证（不采信报告结论直接改）。

### 修掉的（10 处，10 个原子提交）

| 级别 | 问题 | 修复 |
|------|------|------|
| 高 | `server.js:77,82` 的 `new URL(req.url)` 与 `decodeURIComponent()` 跑在 Next 之外且无兜底：`GET //` 抛 TypeError、`/files/%E0%A4%A` 抛 URIError。实测（旧代码）：该请求**永远挂住不返回**（客户端 timeout/000），每来一条就抛一次 uncaughtException、连接不回收；dev 下侥幸被 Next 的全局兜底接住，生产自定义服务器下这一抛就是整个进程退出、在跑的任务全丢 | 两处入口按 400 处理（`/files` 的解码失败另给 400），`upgrade` 用畸形 URL 时直接断连。**不加**全局 `uncaughtException` 兜底：未知异常之后继续跑属于掩盖问题、状态可能已坏 |
| 中 | `llm.js` 无条件要求 `apiKey`，而 `preflight` 检查 `/models` 时本来就不发鉴权头 —— 用无鉴权本地 LLM（llama.cpp 等）的用户「预检通过、每个 LLM 阶段都失败：未配置 LLM api_key」 | 改成只在配了 key 时才带 `Authorization`；必须配的是 Base URL。同时把「超时」与「连不上」分开报：服务在跑但卡住时原先把用户引去重启一个活着的服务 |
| 中 | `stages.js` 的 CK 回归判定写成 `verLe(ckKitchen, CK_BAD_MAX)`（≤0.2.36 全判坏），与仓库里的官方报告相反：`plan/CK注意力回归问题调查报告.md` §6 的版本定位是 #207/#208 在 0.2.35 **之后**才落地、随 **0.2.36** 打包 → 0.2.35 及更早走旧 mask 路径、不受影响。原判定把没问题的旧版本一起拦住（白丢 2.7x 速度），对将来可能仍带缺陷的新版本反倒放行 | 改为下限判定（`≥0.2.36` 才算坏），常量改名 `CK_BAD_MIN` 并写明「上游修好后怎么改」；`preflight` 顺带把 LLM 的 401/403 与「服务没起来」分开提示 |
| 中 | `stages.js` 阶段任务被停止后仍记 `status:'done'` +「完成」：`run()` 在停止时是**正常 resolve**（各阶段自己 return/break），`.then` 却无条件置 done，前端收到 `status:'done'` 就弹「✅ 任务完成」—— 明明后面几章都没出 | `.then` 与 `.catch` 同口径：`isAborted(job.id)()` 为真记 `cancelled`。判据不用 `run()` 返回的 `results.aborted`：它只在「下一个阶段开始前」置位，停在最后一个阶段时根本不会设置 |
| 中 | 背景音乐资产：路由发起任务前就置 `generating`，只有工具内部会改成 `done/failed`。任务在**排队期间**被停止（或排队超时、或工具在写状态之前抛错）时工具根本没跑 → 资产永远停在「生成中」，列表一直转圈且无法重试 | `startMusicJob` 的 `.catch` 里兜一道：仍是 `generating` 就按 `failed` 复位 |
| 低 | `ConsoleTab` 的「完整日志」固定取 `jobs[0]`（最后创建的一条），而最后创建的常常是刚入队、还没写日志的命名/子任务 → 面板显示「（暂无完整日志）」，用户想排查刚失败的那条看到的却是别人的日志 | 改成：正在执行/排队的任务 → 最新一条写过日志文件的任务 → 最新任务 |
| 低 | `ProjectView.loadProject` 没有 `catch`：id 不存在 / 项目被别的标签页删掉时，`Promise.all` 的拒绝无人处理，界面永远停在「项目加载中…」，连返回按钮都没有 | 给出错误文案 +「返回列表」；同时加在途请求序号（WS 每条消息 + 2.5s 轮询 + 初始加载会同时在飞，先发后到的旧响应会把新状态盖回去） |
| 低 | `ProjectsPage.create`：POST 已成功、项目已落库，若后面的取章节 / 传参考图失败只弹一条 toast：列表不刷新、也不进项目 → 用户以为创建失败，再点一次「创建并打开」，同一个项目建了两遍（`Projects.create` 不限制重名） | POST 成功即刷新列表，参考图另包一层错误提示，最后始终进入项目页 |
| 低 | `SkillsTab.rescan` 没有 `catch`：重新扫描失败时拒绝无人接管，按钮点了完全没反应 | 失败弹 toast |

### 本轮核对过、判定「不改」的项

- **`ffmpeg` 拼接为每个输入强制 `-f lavfi -i anullsrc` 音轨**：要断言「镜头视频可能没有音轨」才能算 bug，而本项目的视频一律由 H3（自带语音）产出；真缺音轨时合并会**大声失败**并给出 ffmpeg 原始错误，不是静默出错。缺证据，不改。
- **`openclaude-agent` 把 `providerEnv(cfg)` 写进 `process.env`**：代码里写明了理由（部分 provider 读 `process.env`）。风险面是「本进程内其它代码能读到」——读到的都是我们自己的配置；唯一被 spawn 的子进程是 ffmpeg，参数由内部拼装、不读这些变量。属风格问题，不改。
- **`createToolRuntime` 抛错时 `Jobs.create` 已落库（孤儿 running job）**：该错误只有「项目不存在」一种，而 `startStageJob` 从路由检查项目到 `createToolRuntime` 是**同步**执行的（中途没有 await，单线程下无人能插进来删项目），因此不可达，不改。
- **`comfyui/test`、`llm/test` 可被用来打任意内网地址（SSRF 面）**：这两个端点的**用途**就是让用户填地址测试连通性，且本应用是无鉴权的本地单用户工具（能调它的人本来就能直接改配置）；跨站页面用 JSON POST 还需过预检。属设计取舍，已记录。
- 沿用前面几轮的判定：`withRetry` 死代码、`abortFlags` 只增不减、`PUT /api/config` 整体覆盖语义、`installSkillsFromZip` 中途失败不回滚、`shots/zip` 空集 500、`mergeVideos` 的 volume、`music/apply` 路由层不校验 `music_id`、章节/分镜 PATCH 无 `activeJobOf` 守卫、`shots/zip`/`export` 缺 `Projects.get`、资产名为空、章节标题不做存储归一化。

第五轮验证口径：`node --test "tests/*.test.mjs"` **130/130**（本轮新增 4 项：阶段停止记 cancelled、音乐资产复位、`llmChat` 无 key 可用、`llmChat` 超时提示；改写 CK 判定 1 项）；反向验证（只撤掉 `stages.js`+`llm.js`+`job-runner.js` 三处修复）**恰好这 5 项失败、其余 125 项照常通过**（零回归）。实机：畸形请求探针 **5/5**（`//`、`/files/%E0%A4%A`、`/files/%` → 400，畸形 upgrade → 断连，正常请求不受影响；同一探针对旧代码是 1/5、且请求挂死 + 每次一条 uncaughtException）；`ic-audit-e2e` **88/88**、`ic-refguard-e2e` **15/15**、第四轮两条探针 **各 6/6**；界面 `GET /`、`GET /?id=<项目>` 均 200（本轮改了 4 个页面的编译通过）。

## 十四、第六轮：把「停止」当一条完整链路审，并首次系统深审 `lib/agent/tools.js`

第五轮把范围推到两侧后，第六轮做两件事：一条对抗式复核线专门**反查第五轮 diff**（挑新引入的问题），一条深审线首次把 1400 多行的 `lib/agent/tools.js`（内置 Agent 的全部工具）逐段过一遍。结论是：本轮最集中、最严重的一类问题是**「停止」只停了一部分**——用户按下停止之后，队列项还会被执行、换装/年龄兜底还会逐镜提交、整章合并还会跑完；其次是**同一件事在两处口径不一致**（LLM 门槛、取消的收尾状态、时长校验）。

### 修掉的（12 处，12 个原子提交）

| 级别 | 问题 | 修复 |
|------|------|------|
| 高 | `comfyui.generate()` 先 `queuePrompt` 提交、之后才检查停止标记；而 `abort()` 只调 `/interrupt`——它只打断**正在执行**的那一项，已经排进 ComfyUI 队列的项稍后照样被逐个执行。用户点了停止，队列里还留着自己刚提交的生成，等于停下来继续烧 GPU（单镜视频可达数分钟） | 提交前先查停止标记直接抛；`abort()` 除 `/interrupt` 外再按 `prompt_id` 调 `POST /queue {"delete":[id]}` 删掉自己**尚未执行**的队列项（接口见 ComfyUI `server.py` 的 `post_queue`）。新增 `deleteQueued()` 并配 3 项单测（提交前不提交、中止时两条请求都发、空 id 不发请求） |
| 高 | `tools.js` 的换装兜底（`autoResolveOutfits`）与年龄兜底（`autoResolveAges`）循环**没有**停止检查：每一次「换装事件/年龄事件」都是一次真的图生图提交，用户停止后仍会一镜一镜继续出图 | 两个循环开头加 `ctx.isAborted()` 检查即退出（停止后重跑该阶段会幂等补齐绑定） |
| 高 | `set_storyboard` 的 `duration` 未做数字校验：模型写 `"8秒"` 时 `sb.duration \|\| 8` 取到字符串、`Math.max/min` 得到 `NaN` 落库；而 `validateSubShots` 把 `NaN` 当 0 秒 → 该分镜**永远出不了片**（任何子分镜都判「超过总时长」，错误信息里只有「超过」两个字，看不出根因）。同一处 `shots:[null]`（模型偶尔这么写）会让后面的遍历抛 `TypeError: Cannot read properties of null` | 加 `durationOf()` 唯一入口：非数字当场报错（与 `update_shot`／外部 API「必须是有限数字」同口径）、越界仍夹到 `[1,15]`；非对象元素同样当场拒绝并点名第几条。（`update_shot` 早就是对的，只有这条路径漏了） |
| 中 | `startChapterVideoJob` 被停止后仍记 `status:'done'` +「完成」：`generate_chapter_videos` 停止时是**正常返回**（`{aborted:true}`，不抛错），`.then` 无条件置 done → 前端弹「✅ 任务完成」，而后面几镜根本没跑。第五轮只修了阶段任务那条 `.then`，同源问题在 `job-runner.js` 里还有 8 处 | 抽出 `finishJobOk()`：与 `finishJobError` 同口径看 `isAborted(job.id)()`，为真记 `cancelled`；9 处 `.then` 全部改用它（一处修改覆盖全部「工具正常返回但其实被停止」的路径） |
| 中 | 背景音乐**重新生成**失败/被停止时，把该资产上已有的 `audio_path` 一并作废成 `failed`：列表里上一版音频还在播，但「应用到章节」按钮（只对 `done` 显示）直接消失，用户既用不上旧的、也没拿到新的。而分镜路径早就是「取消恢复原视频」的口径 | 与分镜同口径：取消/失败时若资产上已有音频则恢复 `done`（保留旧音频），确实没有音频才标 `failed`；工具内 catch 与 `startMusicJob` 的兜底 catch 两处都改 |
| 中 | LLM 门槛残留 `apiKey`：`/api/llm/test`、参考图上传的视觉命名（`references` 路由）、`edit_asset_image`/年龄变体的视觉精修（`tools.js`）都以 `apiKey` 为门槛。第五轮已把 `llmChat` 与 `preflight` 改成「只要求 Base URL」，但这些入口没跟上 → 用本地无鉴权端点（llama.cpp 等）的用户「测试连接」直接判负、视觉功能静默降级 | 统一到 Base URL（`vision` 开关 + `baseUrl`）。实机探针证明：无 `apiKey` 的本地端点现在能测通（`ok:true`、且确实没带 `Authorization`） |
| 低 | `preflight` 用 `base + '/models'` 探测，而真正调用走 `llmEndpoint()`（会自动补 `/v1`）：用户把 Base URL 写成 `http://127.0.0.1:8080` 时，预检打 `/models` 通过、真实调用打 `/v1/chat/completions` 却 404 —— 「预检过了，每个阶段都失败」 | 探测地址改用 `llmEndpoint()` 推导（`/models` 由 `/chat/completions` 换得），与调用同源 |
| 低 | `comfyui.js` 的 `comfyFetch` 把**假死超时**也说成「无法连接 ComfyUI，请确认已启动」：连接是通的（进程活着、在加载模型或卡住），这句会把用户引去重启一个本来就活着的服务。`llm.js` 第五轮已经分开报，这里没跟上 | 按 `TimeoutError/AbortError` 分开报「响应超时（连接是通的）」与「无法连接」 |
| 低 | 单镜渲染被停止时写成 `status:'failed'` + `error:'已取消'`：用户点一下「停止」就在分镜上看到一条失败记录（章节批量路径会把它复位成 `pending`，单镜路径不会）。停止不是失败 | 与 `generate_chapter_videos` 收尾同口径：已有成片恢复 `done` 并保留原视频，尚未成片回到 `pending`、清空 `error` |
| 低 | `edit_asset_image` 的 `reference_asset_id` 不校验项目归属：跨项目 id 会按**本项目**路径解析（两个项目都有 `assets/character/xxx.png` 时），拿错图当参考 | 参考资产必须属于本项目，否则「参考资产不存在」 |
| 低 | CK 版本判定里 `(pa[i] \|\| 0)` 的解析太宽松：`0.2.37rc1` 逐段 `Number()` 得到 `NaN`、再被当成 0，于是 `0.2.37rc1` 被读成「0.2.0」而**放行**。本机装的正是 `comfy-kitchen 0.2.37`（`plan/ComfyUI_MiniMaxH3_AMD_7900XTX_Plan.md:1153` 逐 commit 核实：0.2.37 只修了 NaN，token>64 的 mask 崩坏**未修**），旧解析会让 `0.2.37rc1` 这样的版本号绕过拦截 | 版本号必须是纯数字段，含后缀（`rc1`/`+cu124`）或为空一律算「读不准」→ **保守判坏**（误伤的代价只是少 2.7x 速度，反了就是一批废图） |
| 低 | `mergeVideos` 没有中止通道：整章合并（长章节可达数分钟）期间点停止完全无效，ffmpeg 照跑到底 | `runCapture` 增加 `isAborted` 轮询、命中即 `SIGKILL` 子进程并报「已停止」；`runFfmpeg`/`mergeVideos` 透传，`assemble_video` 传入 `ctx.isAborted`（半截产物文件按既有「失败留孤儿文件」口径处理） |

### 本轮核对过、判定「不改」的项

- **`update_shot` 改台词不重置 `video_prompt_used`（不触发重渲染）**：视频阶段的跳过规则就是「已出片且**提示词**没变过」（改提示词即重出，写在工具说明里）；把「改台词」也当失效会让整章在下次运行时全量重渲染（几十镜 × 数分钟），成本不可控。单镜「重新生成」按钮与 `regenerate_shot` 都在手边。不改。
- **`upsertMusicAsset` 同名复用可能覆盖用户自建的同名音乐资产**：名字就是「某章 BGM」这个业务槽位（该设计有成文注释与既有测试），覆盖同时写变更日志（可回滚），磁盘上旧文件也不删；改成「另建一条」会重新引入两条同名音乐谁对应哪章的歧义。不改。
- **兜底提示词会被写进 `video_prompt`**：`generate_shot_video` 的文档明确写「未写提示词时用兜底提示词并记录」；之后 LLM 若写下正式提示词，`video_prompt_used !== video_prompt` 会让该镜下次重出（既有已知行为）。不改。
- **`assemble_video` 的整片合并（不传 `chapter`）与 `/export` 路由不响应停止**：两者都是「请求内同步等待」的一次性动作，界面不为它们显示停止按钮；按章合并（含 `apply_chapter_music`）已支持中途停止。属设计取舍，已记录。
- 沿用前面几轮的判定（不再重复理由）：`withRetry` 死代码、`abortFlags` 只增不减、`PUT /api/config` 整体覆盖语义、`installSkillsFromZip` 中途失败不回滚、`shots/zip` 空集 500、`mergeVideos` 的 volume、`music/apply` 路由层不校验 `music_id`、章节/分镜 PATCH 无 `activeJobOf` 守卫、`shots/zip`/`export` 缺 `Projects.get`、`comfyui/test`+`llm/test` 的 SSRF 面、`openclaude-agent` 写 `process.env`、`startStageJob` 里 `Jobs.create` 早于 `createToolRuntime`、`ffmpeg` 强制音轨、素材空名、`Chapters.create` 不做存储归一化、`pendingByStage` 的 tts 计数、`custom` 空宽高 → 1024×576、同名资产 `byName` 取最新、`DELETE /references/:rid` 连带删关联素材。

第六轮验证口径：`node --test "tests/*.test.mjs"` **138/138**（本轮新增 8 项：停止后不再提交、中止时按 `prompt_id` 清队列、`deleteQueued` 请求形态、`runFfmpeg` 中止杀子进程、换装/年龄兜底循环停止后零提交、章节视频任务记 `cancelled`、音乐重生成停止保留旧音频、`set_storyboard` 时长与元素校验；改写「停止复位」1 项以对齐新口径）。反向验证：整批撤掉源码修复 → 单测文件因 `deleteQueued` 未导出直接加载失败、3 项 changelog 新测试逐条失败；逐条撤（提交前检查／中止清队列／兜底循环检查／ffmpeg 中止通道）→ 对应测试各自失败，其中 `runFfmpeg` 一项在旧代码下**跑满 17.9s 才结束**，正是「停止后合并照跑」的现场。实机：`ic-audit-e2e` **88/88**、`ic-refguard-e2e` **15/15**、第四轮两条探针 **各 6/6**、畸形请求探针 **5/5**，新增 LLM 门槛探针 **5/5**（无 `apiKey` 的本地端点可测通、地址按 `llmEndpoint` 补 `/v1`、未填 Base URL 报 Base URL、连不上给出可读原因）。

## 十五、第七轮：把写接口之外的剩余面过完，重点是「同一件事两处口径不一致」

第六轮之后还没系统过过的面：全部生成类路由（`assets/[aid]/generate|design-voice|change-outfit|change-age|upload`、`shots/[sid]/regenerate`、`chapters/[cid]/regenerate`、`music/apply`、`shots/zip`、`exports`）、`lib/core` 的 `ffmpeg`/`prompts`/`logger`/`config`，以及界面上传素材的那条链路。结论：生成类路由本身都是薄封装（校验在 `job-runner` 的启动器与工具里，第六轮已审），本轮的实质问题集中在两类 —— **同一个判定在两处不一致**（OpenAI base 的 `/v1`、素材的媒体判定）与**读进内存前没有上限**。

### 修掉的（5 处，5 个原子提交）

| 级别 | 问题 | 修复 |
|------|------|------|
| 高 | `openclaude-agent.js` 的 `providerEnv` 把 `cfg.llm.baseUrl` 原样给 `OPENAI_BASE_URL`，不走 `/v1` 归一化；而 openclaude 的 OpenAI SDK 只在 base 后面拼 `/chat/completions`（`vendor/openclaude/dist/sdk.mjs:234670`）。base 写成 `http://127.0.0.1:11434`（Ollama/LM Studio 的常见写法，界面也允许省略 `/v1`）时：预检打 `/v1/models` 通过、`llmChat` 打 `/v1/chat/completions` 通过，唯独整条 Agent 流水线打 `/chat/completions` → 404 —— 「测试连接全绿、一跑就全失败」，且报错只有 404 | 新增 `openaiCompatBaseUrl()`（`lib/core/llm.js`，紧挨 `llmEndpoint`、复用同一套 `/v1` 规则，成为单一事实来源）并改用它；`baseUrl` 为空仍退回 `https://api.openai.com/v1`。`providerEnv` 不导出（一导出就会拉起 vendor SDK），改用源码守卫用例钉住这一行 |
| 中 | `resolveHardware()` 直接往 `merged.generation` 写属性：`config.json` 被手改成 `"generation": null`（或 `"x"` / `5`）时 `deepMerge` 会原样保留该值，紧接着赋值抛 `TypeError: Cannot set properties of null`。而 `loadConfig()` 每个请求都要跑 → 所有路由 500、`PUT /api/config` 也 500，应用基本不可用，日志里只有一句 `TypeError` | 非对象（含数组）时退回 `DEFAULTS.generation`，再按模式补 `freeAfterEvery` |
| 中 | 素材上传的媒体判定只看 `category`（上传框不限类型，`AssetsTab` 没有 `accept` 过滤）：角色/场景/道具上传 `.gif` → 判成视频写 `video_path`。后果两重：素材卡用 `<video>` 渲染 `video_path`，浏览器根本放不出 gif（一张打不开的黑框）；且 `image_path` 仍为空，拿它当参考图时会被 `refs` 直接跳过。而 `references` 上传路由一直把 gif 当图片，两处口径相反。另外 `other` 分类上传 `.mp3` → 判成图片写 `image_path`（音频挂在图片字段上） | 判定收敛到 `lib/shared` 的 `uploadMediaKind()`：分类优先（`voice/music/sfx` 音频、`video` 视频）+ 扩展名兜底（`.mp3` 等兜音频、`.mp4` 等兜视频、gif 归图片），路由与单测共用一份 |
| 中 | 素材上传路由**没有体积上限**：`Buffer.from(await req.arrayBuffer())` 把整个请求体读进内存。上传框不限类型，选错一个 3GB 的视频文件就让 Node OOM 退出（正在跑的任务一起丢）；`server.host` 常配 `0.0.0.0`，局域网内任意客户端同样能触发。`references` 路由早就有 10MB 上限，这条漏了 | 按媒体类型分档（图片 20MB / 音频 100MB / 视频 500MB）：先按 `Content-Length` 早退（连正文都不读），读完再按实际长度兜一道（分块上传没有该头），超限回 413 并写明该档上限 |
| 中 | `/api/skills/upload` 是同一类问题：整个请求体读进内存后交给 `installSkillsFromZip`（解压也在内存里），同样没有上限 | `SKILL_ZIP_MAX_BYTES = 20MB`，同样两道判断 + 413；所有校验（zip 可解析、路径安全、含 `SKILL.md`）本就在写文件之前，超限路径更早返回，不会污染 `skills/` |

### 本轮核对过、判定「不改」的项

- **`scanSkills` 的 `version: manifest.version || ''` 恒为空**：`manifest` 只被写成 `{metaYaml:true}`（没解析 `meta.yaml` 里的 `version:`），而 `version` 没有任何消费方（`SkillsTab` 只显示名称/来源/描述）。为一个没人读的字段去解析 YAML 不划算。不改。
- **`runInlineJob` 的 catch 恒记 `failed`**（与「取消不是失败」口径不同）：这类 inline 任务（整片导出、参考图视觉命名）**本身不响应停止**，停止标记置位时它们仍会跑完。改成按 `isAborted` 记 `cancelled` 反而是谎报「做完的活被取消了」；现在如实记 `done`/`failed`。真正该改的是让它们能停，而这两条路径在第六轮已判定「保持同步等待」（界面也不给它们停止按钮）。不改。
- **`refs.js` 的「参考图上限 9 张」在全部上传完之后才抛**：多传的图已经落盘（磁盘孤儿文件按既有「失败留孤儿文件」口径处理），但超额请求整体失败、不会写出错误的参考集。不改。
- **`audioTruncated` 在 `rel` 为空时也会置位**：只多挂一个「文本被截断」的提示标记，不影响音频本身。不改。
- **`comfyui.js` 的超时分支不 `/interrupt`、不清队列**：连接假死时服务端任务状态本就不确定，这里只负责如实报错（第六轮已把文案分清）；能主动 interrupt 的前提是服务可用，而超时后大概率不可用。不改。
- **`music/route.js` 的 POST 返回更新前的 asset 对象**：只影响这一次响应里的展示字段，列表刷新后即为最新，改动面大于收益。不改。
- **`runninghub.js:137` 直接用全局 `crypto.randomUUID()`**（其他处从 `node:crypto` 显式 import）：本机 Node 24 全局可用、行为一致，仅风格不统一。不改。
- 仍未收紧的已知面（记录在案）：JSON 请求体（`req.json()`）没有显式上限；`GET /files/*` 只做路径穿越防护、不限体积。两者都建议靠反代与 `server.host` 收敛暴露面。
- 沿用前面几轮的判定（不再重复理由）：`withRetry` 死代码、`abortFlags` 只增不减、`PUT /api/config` 整体覆盖语义、`installSkillsFromZip` 中途失败不回滚、`shots/zip` 空集 500、`mergeVideos` 的 volume、`music/apply` 路由层不校验 `music_id`、章节/分镜 PATCH 无 `activeJobOf` 守卫、`comfyui/test`+`llm/test` 的 SSRF 面、`openclaude-agent` 写 `process.env`、`ffmpeg` 强制音轨、素材空名、`Chapters.create` 不做存储归一化、`pendingByStage` 的 tts 计数、`custom` 空宽高 → 1024×576、同名资产 `byName` 取最新、`DELETE /references/:rid` 连带删关联素材、`update_shot` 改台词不清 `video_prompt_used`、`upsertMusicAsset` 同名复用、兜底提示词写进 `video_prompt`、整片合并与 `/export` 不响应停止。

第七轮验证口径：`node --test "tests/*.test.mjs"` **144/144**（本轮新增 6 项：`openaiCompatBaseUrl` 取值、`providerEnv` 接线源码守卫、非对象 `generation` 不崩、`uploadMediaKind` 判定、`UPLOAD_MAX_BYTES` 三档、`SKILL_ZIP_MAX_BYTES`）。反向验证走两路：

- **单测路**（`ic-r7-reverse.mjs`：逐条撤修复 → 跑对应用例 → 还原后再确认通过）：5 条全部「撤掉即失败、还原即通过」，其中包括撤掉 `providerEnv` 的接线那一行（源码守卫用例失败）。
- **实机路**（撤掉修复后跑探针，用真实响应取证）：撤掉素材上限 → 21MB 图片从 413 变 200、文件真的落盘；把 gif 放回视频扩展名 → gif 落进 `video_path`；去掉音频扩展名兜底 → `other` 分类的 mp3 落进 `image_path`；撤掉技能包上限 → 21MB 正文被完整读进内存后才由 zip 解析器报错。
- **新探针**：素材上传 **20/20**（含分块无 `Content-Length` 的 21MB → 413、25MB 音频不被图片档误拦、`voice` 素材仍双写 `voice_ref`+`audio_path`）、技能包上传 **5/5**。回归：`ic-audit-e2e` **88/88**、`ic-refguard-e2e` **15/15**、第四轮两条探针 **各 6/6**、畸形请求探针 **5/5**、LLM 门槛探针 **5/5**。
- 一处**未能实机覆盖**并如实记录：`providerEnv` 到 openclaude 的接线无法端到端跑（需要真实 LLM 跑完整条 Agent 流水线），故用源码守卫 + `openaiCompatBaseUrl` 值断言 + vendor SDK 的拼装证据（`sdk.mjs:234670`）三者共同锁定。

## 十六、第八轮：换角度审「同一件事在两个入口口径不一致」与「界面假成功」

前七轮把外部写入 API、生成链路、停止语义、同一判定多处漂移都过了一遍。第八轮换两个角度：（a）**同一条业务规则在「LLM 工具入口」与「界面/HTTP 入口」口径不一致** —— 界面做的事 LLM 不能做、或两处判定不同；（b）**界面的假成功** —— 提示语宣称的成果与后台实际做的事不符。方法：三个子代理并行走查界面各页，本地逐条核验，并取上游 `SwotAtmk/infinite-creation`（`refs.js`/`tools.js`）对照判断是本仓独有还是上游同样存在。

### 修掉的（7 个原子提交）

| 提交 | 级别 | 问题 | 修复 |
|------|------|------|------|
| `db7ab4d` | 中 | `refs.js` 判定「本镜谁在说话」用 `s === c.name \|\| s.includes(c.name) \|\| c.name.includes(s)`：同场有「小明」和「明」时，说话人「小明」会把「明」也算成说话人，「明」被错挂音色（台词音色串到同名短角色上） | `lib/shared` 新增 `normalizeName` / `nameMatches`（规范化后**精确相等**，只容忍身份后缀与空白），`refs.js` 与 `ShotsTab` 共用。实测：说话人「小明」+ 同场角色 小明/明 → 旧判定 `['小明','明']`、新判定 `['小明']`。上游同样未修，本仓自行统一 |
| `e902773` | 中 | `tools.js` 的自动换装/年龄用 `text.includes(char.name)` 判定「本镜文本是否提到该角色」：同场有「小明」和「明」时，文本里的「小明」让 `includes('明')` 为真 → 给「明」也真提交一次图生图（Qwen-Image-Edit），白烧 GPU，并把不属于他的服装/年龄写进本镜参考 | `lib/shared` 新增 `textMentions(text, name, allNames)`：只有当某次「名字出现」没被同场更长的角色名完整覆盖时才算真提到；两条归属路径（换装/年龄）共用 |
| `202412b` | 高 | **服装/年龄变体不绑角色**：这两个分类全流程只按 `parent_id` 认（`refs.js` 按它映射到角色，`tools.js` 只把带 `parent_id` 的算作已有变体），而 `POST /assets` 一直丢掉 `parent_id`、界面新建/上传也不传 → 用户上传的服装/年龄变体素材库里看得见、分镜能引用、点保存也成功，**生成时被完全忽略**，还会被自动换装再生成一套 | 三处同一道不变量：① `lib/core/db.js` 的 `Assets.create/update` 变体必须带 `parent_id`（`BAD_VARIANT_PARENT`，中央守卫，LLM 工具入口一并拦住；`update` 只在主动动 `category/parent_id` 时拦，存量无父变体仍可改名清理）；② HTTP 路由接受并校验 `parent_id`（必须指向**本项目**的**角色**素材，跨项目/指场景/指不存在都 400；守卫码翻 400 而非 500）；③ 界面新建资产与分镜「＋服装/＋年龄」的上传都必须先选「所属角色」（分镜内只有一个角色时自动选中，没有角色则禁用上传并提示） |
| `173823b` | 中 | **假成功**：`ProjectView.run` 自己 `catch` 后只弹一次错误、**不抛出**，而 `ChapterOps` 的「生成/继续」`await onRun(...)` 后无条件弹「已提交…生成」—— 409「已有运行中的任务」/400 时用户同时看到「错误」和「已提交」两条互相矛盾的提示，还会点「前往运行日志」找一个并不存在的任务；`ChaptersView` 的章节卡片「生成」还裸调 `onRun(c.title)`（错误成为未处理拒绝，点了完全没反应）。另：`ChapterOps` 拉 `/stages` 用 `.catch(() => {})` 静默吞错 → `stageList` 恒为 `null`，界面永远停在「分阶段运行加载中…」 | `run` 把错误抛给调用方（各自唯一的 `catch` 提示）；章节卡片改走带 `catch` 的 `submitRun`；`/stages` 失败把原因显示出来（成功时清空） |
| `54faeeb` | 中 | 参考图上传前后端口径不一致：后端只认 `.png/.jpg/.jpeg/.webp/.gif` + 10MB，前端按 `file.type.startsWith('image/')` 过滤 → bmp/avif/svg/tiff 能选中、**上传到那张才 400**（前面的已落盘，留下半截状态）；而没有 MIME type 的合法 png 又被**静默丢掉**（连提示都没有）；`accept="image/*"` 还让文件框摆出选不了的类型 | `lib/shared` 增加 `REFERENCE_IMAGE_EXTS` / `REFERENCE_IMAGE_MAX_BYTES` / `isReferenceImageName`，路由改为引用共享常量；选择器按同一白名单判定、超限提前拦，被跳过的文件分「非支持格式」「超 10MB」两类明确提示；`accept` 改成明确列表 |
| `7a92b21` | 中 | 背景音乐三处「说的和做的不一致」：①「应用到」成功后提示「已应用背景音乐并重新合成成片」，但接口只是**入队**（用户按提示去成片页只有旧片）；②`apply_chapter_music` 逐章 `try/catch`（本意对：单章失败不中断其余章节），但**全部章节失败**时照样正常返回 → 任务被记成 `done`、界面弹「✅ 任务完成」，用户什么都没得到却被明确告知成功；③详情弹窗存的是点击时的对象**快照**，弹窗开着时轮询/生成写回的新状态永远反映不到里面 | ①成功提示改为「已提交…逐章进度与失败原因见运行日志」；②全失败（且非用户停止）时抛错，**逐章原因带进错误**（日志/任务详情仍能看清是哪一章、为什么），`aborted` 不抛（用户主动停止属于「取消」，与阶段任务停止语义一致）；③详情只存 id、值从最新 `assets` 派生 |
| `e79641f` | 低 | UI 三则：①`ShotsTab` 空态判的是未筛选的 `shots.length`，按章筛选时本章一条分镜都没有却连「暂无分镜」都不显示（只剩标题，像渲染坏了）；②`ProjectView` 的分镜页「当前章节」游标存**下标**，章节可拖拽排序/删除/新增 → 排序一次就看着 A 章的名字渲染 B 章的分镜；③`ChaptersView` 批量上传参考图，一条失败时已成功的仍留在待上传列表，用户再点一次就**重复上传**（素材库多出重复参考图），且错误不说哪个文件、不说前面成功几张 | ①改判 `shown.length`；②游标改存章节 id（列表刷新时 id 还在就保持选中，否则退回第一章），下拉 key 也从下标改 id；③成功一条立刻按 key 从待上传列表摘掉，错误里带上文件名与已成功数量 |

### 本轮核对过、判定「不改」的项

- **`ChaptersView` 拖拽排序的 splice 语义**：拖拽项最终落在高亮圈对应的 `to` 下标上，与视觉提示自洽（不是「差一位」的经典 bug）。不改。
- **上游 `SwotAtmk` 的 `ShotsTab.jsx` 同样没修短名串扰**（`refs.js` 上游已用 `nameMatches`、`tools.js` 上游有 `textMentions`/`mentionsName`）：本仓把界面展示也统一到同一判定，属于本仓增强，不回灌上游。
- **`tools.js` 里 LLM 的 `create_asset` / `generate_asset_from_reference` 能造无 `parent_id` 的变体**：本轮判定**已由 db 层守卫覆盖**（不再是「文档残留项」）—— 两条路径都会命中 `BAD_VARIANT_PARENT` 并收到可读错误，LLM 会据此改用 `change_outfit`/`change_age`。
- 以下判定**延后、登记在案**（都是界面体验类、不影响数据正确性，改动面大于收益）：
  - `ChaptersView` 的「保存本章」不提交参考图，参考图要在上传区另点一次；
  - 编辑弹窗关闭会丢掉未保存的文本（没有草稿保护）；
  - 分镜音频引用超过上限（`MAX_AUDIO_REFS`）时静默截断，界面没有提示；
  - `ShotMaterialPicker` 上传音频时分类恒用 `voice`（`music`/`sfx` 也能当参考音频，但界面只能传 `voice`）。
- 沿用前面几轮的判定（不再重复理由）：`update_shot` 改台词不清 `video_prompt_used`、`upsertMusicAsset` 同名复用、兜底提示词写进 `video_prompt`、整片合并与 `/export` 不响应停止、`withRetry` 死代码、`abortFlags` 只增不减、`PUT /api/config` 覆盖语义、`installSkillsFromZip` 不回滚、`shots/zip` 空集 500、`mergeVideos` 的 volume、`music/apply` 路由层不校验 `music_id`、章节/分镜 PATCH 无 `activeJobOf`、`comfyui/test`+`llm/test` 的 SSRF 面、`openclaude-agent` 写 `process.env`、`ffmpeg` 强制音轨、素材空名、`Chapters.create` 不归一化、`pendingByStage` 的 tts 计数、`custom` 空宽高 → 1024×576、同名资产 `byName` 取最新、`DELETE /references/:rid` 连带删关联素材、`refs.js` 参考图上限在全部上传后才抛、`audioTruncated` 在 `rel` 为空也置位、`comfyui.js` 超时不 interrupt、`music/route.js` POST 返回陈旧 asset、`runninghub.js` 用全局 `crypto.randomUUID()`，以及仍未收紧的 JSON 请求体 / `GET /files/*` 体积（建议靠反代与 `server.host` 收敛）。

### 第八轮验证口径

- 单测：`node --test "tests/*.test.mjs"` **155/155**（本轮新增 7 项 + 改 1 项：`nameMatches`、`textMentions`、变体判定与写入端不变量、参考图白名单与单源守卫、音乐应用全失败必须报失败、UI 三则源码守卫）。
- 反向验证（撤掉修复即失败）：
  - 单测路：`nameMatches`/`textMentions`/`Assets.create` 变体不变量/参考图守卫/音乐全失败/UI 三则 —— 逐条撤掉后对应用例立即失败，还原即通过；其中 UI 三则的 7 条断言还用脚本**跑在 HEAD（修复前）版本**上，7/7 全部不成立，证明守卫不是恒真的空断言。
  - 实机路：把 `assets/route.js` 回退到 HEAD 版本 → `ic-r8-parent-probe` 从 19/19 变成 **9 项失败**（无父变体 400 变 200、`parent_id` 落空等）。
- 新探针 `ic-r8-parent-probe.mjs` **19/19**：无父 costume/age → 400；带本项目角色 → 200 且 `parent_id` 落库；`parent_id` 指场景 / 指别的项目的角色 / 不存在 → 400；`PATCH category→costume`（无父）→ 400 且分类未被改动；character/other 不带 `parent_id` 仍 200（回归）；参考图 `.bmp` → 400、`.png` → 200；`GET /` 200。
- 回归：`ic-audit-e2e` **88/88**、`ic-refguard-e2e` **15/15**、第四轮两条探针 **各 6/6**、畸形请求 **5/5**、LLM 门槛 **5/5**、素材上传 **20/20**、技能包 **5/5**。
- 一处如实记录**未驱动浏览器**：弹窗/游标/toast 这类界面行为用「源码守卫 + HEAD 版反证 + 页面编译 200」锁定，没有用真实浏览器点按验证（本机只有 dev server，无 E2E 浏览器驱动）。



## 十七、第九～十轮：把「内容键 / 归属键两端口径不一致」与「写入端静默无效」两类收口（2026-10-16，dev7）

前八轮把外部写入 API、生成链路、停止语义、界面假成功过完。第九、十轮换两个角度：（a）**同一份数据在「写入端」与「消费端」口径不一致**——写进去的值在消费时被忽略或误用（内容键、归属键、产物字段）；（b）**写入端静默无效**——harness / LLM 工具 / 界面三方都能写的内容，写进去之后生成时被静默忽略，写入方读回去却以为生效了。

### 第九轮修掉的（16 个原子提交）

| 提交 | 级别 | 问题 | 修复 |
|------|------|------|------|
| `fb13089` | 高 | `/ws` 的客户端畸形帧（非 UTF-8 / 非 JSON）会在 `WebSocketServer` 上抛 `error`，而 `server.js` 没有监听它 → **未捕获 error 直接让整个进程退出**，把 dev 实例和正在跑的任务一起带走 | 给服务端与每条连接加 `error` 监听，只关掉那条坏连接（`malformed-probe` 守着） |
| `d5e1ccb` | 中 | `/files` 的 Range 解析把后缀范围 `bytes=-N` 当成 `start=-N` → 返回**开头** N 字节而不是末尾 N 字节（播放器/下载器校验文件尾部时拿到错数据、静默出坏片） | 后缀范围单独按 `size - N` 处理，并收敛非法区间 |
| `7563b04` | 高 | 参考图上传/编辑路径能建出**无父变体**（服装/年龄）：db 层守卫抛的 `BAD_VARIANT_PARENT` 在路由里没翻 400 → 500；且上传路径在抛错前**已把文件落盘**（半截写入） | 前置校验分类（变体必须带 `parent_id` 且指向本项目角色）+ 把守卫码翻 400 + 校验放在落盘之前 |
| `5a76c43` | 中 | `textMentions`：canonical 名带身份后缀（如「林默（少年）」）时短名仍被判成「被提到」，换装/年龄归属套到错角色上 | 归属判定同时收原名与规范化名 |
| `3d4c956` | 低 | `isReferenceImageName('.png')`：只有扩展名、没有主名的名字被当图片放行 | 要求主名非空 |
| `fb494c8` | 中 | 运行日志页：完整日志随 `jobs` 数组引用被反复重取（每次轮询重取全部日志），过期的响应还会覆盖新状态 | 按 job 缓存已取过的完整日志 + 丢弃过期响应 |
| `2fd4a3b` | 中 | 设置页配置拉取失败时永久停在「配置加载中…」（没有任何错误出口） | 显示失败原因，成功时清空 |
| `8f21311` | 高 | `resolveHardwareConfig`：配置段被写成非对象（字符串 / 数组 / 数字）时把非对象原样返回 → 设置页白屏、全站 500 | 五段配置「非对象一律退回默认」 |
| `d33f54b` | 中 | `skill-engine.scanSkills` 不清理陈旧行：删掉 `skills/<dir>` 后技能表里仍留着这条（界面列着、点开加载不出内容） | 扫描时清理已消失目录的行 |
| `1a00179` | 中 | 回滚「章节新建」时按 `log.before.title` 级联删分镜 → 章节**改过名**后级联漏删，留下孤儿分镜 | 级联删用**当前行**的 title |
| `f3c29a4` | 中 | 分镜素材选择器列出了全部服装/年龄变体（可跨角色绑定，生成时按 `parent_id` 找不到本镜角色 → 静默不用） | 选择器只列、只绑「本镜角色」的变体 |
| `84e2480` | 高 | 工具 schema 的 `create_asset` / `generate_asset_from_reference` 没暴露 `parent_id` → 模型想建变体只能写出无父变体，撞 db 层 `BAD_VARIANT_PARENT`，且那是**模型看不懂的 DB 错误**、无法补救 | schema 补 `parent_id`，新增 `resolveAssetParent`（变体必须指向本项目角色），工具侧给出可读指引 |
| `ad4aea2` | 低 | 界面素材分类下拉漏了 `age`（与 `ASSET_CATEGORIES` 漂移） | 从 `ASSET_CATEGORIES` 单源派生 |
| `c5e0b11` | 中 | 自定义分辨率的宽高没有区间校验：`width=5` / `height=99999` 能落库，直到提交工作流才炸 | 区间校验**下沉到 db 层**（`BAD_PROJECT_DIM`）：`0 = 未设置`仍可写，非 0 必须 64~4096 |
| `33e3a8e` | 中 | 非变体分类带了 `parent_id`：写上去只会被 `Assets.remove` 当子变体级联删（删角色时道具一起没）、被 `usageOf` 计成 children（删除确认里冒出假「子变体」） | db 层 `BAD_ASSET_PARENT` + assets POST/PATCH、references、Agent 工具四入口一致拦（`update` 只判本次主动写 `parent_id`） |
| `ffb7b00` | 中 | `refs.js` 对白说话人匹配不上本镜角色时**静默丢音色**（用户只看到「这一镜没有声音」） | 不改判定（拆逗号会误伤台词正文），只把静默变可观测：`logger.warn` + 返回 `unmatchedSpeakers`，由 `generateShotVideo` 上报运行日志 |

### 第十轮修掉的（3 个原子提交）

| 提交 | 级别 | 问题 | 修复 |
|------|------|------|------|
| `fb6bc25` | 中 | **改分类离开变体分类**不清 `parent_id`：服装改成「道具」后父指针留在行上 → 这条已不是变体的素材被 `Assets.remove` 当子变体级联删、被 `usageOf` 计成 children | `Assets.update` 在**本次主动写** `category` 且离开变体分类时清空 `parent_id`（只判主动写的字段，存量脏数据不连累「改个名字」这类无关编辑；变体之间互改保留父；非变体→变体仍受「必须有父」拦截） |
| `ea10e67` | 高 | **删项目不停本项目活动任务**：任务行随 `Projects.remove` 一起删掉，而进程里那条任务不会停（停止注册表按 jobId 在内存里）→ 它继续出图/出片，把 chapters/shots/assets 行插回一个「已经不存在的项目」——项目页与任务列表都没了，用户既看不到也停不掉，只剩占显存、孤儿行，还会把项目目录重建出来 | 先 `stopJob`（`running` **与** `queued`，排队中的立即出队，否则还会被调度起来跑），执行中的再主动 `interruptTask` 一次（与 `/stop`、`/cancel`、删除单个任务**同一口径**），最后 `Projects.remove` + 删目录，并回报 `stopped` 列表 |
| `a07ec71` | 中 | **分镜 `*_ids` 绑定写入端不校验**：悬空 id（素材被删后界面每次保存又整条写回、用户没有任何入口删掉它）、错类 id（场景塞进 `character_ids`）、跨项目 id 原样落库，生成时被 `refs.js` 静默忽略（少一份参考图/音色），harness 读回去却像绑上了 | db 写入层（`Shots.create`/`update` 共用一处 `normalizeShotRefs`）按「本项目素材 + 字段对应分类」（新增 `SHOT_REF_FIELD_CATEGORIES`，`audio_ids` 复用 `AUDIO_ASSET_CATEGORIES`）归一化，丢弃的 id 打 `logger.warn`。**丢而不抛**：界面保存写的是整条数组，行里一旦有悬空 id（历史的/回滚回来的/删素材造成的），严格拒绝会让那一镜之后再也绑不上任何素材；只处理本次主动写的字段，回滚走原生 SQL 不受影响 |

### 本轮核对过、判定「不改」的项

- **`seed` 是「可写内容字段」与「渲染产物」两重身份**（取证脚本 `ic-r10-seed-evidence.mjs` 三条实测）：① 只改 `seed` 的 `PATCH` **不产生变更日志**（`VOLATILE.shot` 含 `seed`）→ 那个批次回滚撤不掉这次写入；② 同批连带改了内容字段时**有**日志，但回滚只还原内容字段、`seed` 被当产物保留（`buildRestoreRow`）；③ 渲染路径（`agent:` 工具）刷 `seed/status/video_path` 不记日志——这正是 `VOLATILE` 存在的理由。而渲染前 `tools.js` 会 `Shots.update(… seed: randomSeed() …)` **无条件重写**：写在白名单里的 `seed` 对出片没有任何影响。**判定：属产品决策，本轮不改**。要一致只有两条路：把 `seed` 从写入白名单里去掉（与 Skill 文档「分镜可写字段」冲突，需用户确认），或把它从 `VOLATILE` 拆出（渲染每次都会多一条整行日志，且要区分「外部写」与「渲染写」两套语义）。留待用户定。
- **列表类 GET 对不存在的项目返回 200 + 空集合**（`/assets`、`/shots`、`/chapters`、`/context`、`/references`、`/jobs`），详情类与项目级读接口 404。全库一致（不是 `context` 独有），且外部写入方写之前都会被写接口的 404 拦住 → 不改。
- **`Assets.remove` 不清理分镜里的悬空绑定**（删角色后 shots 仍留着那个 id）：消费侧（`refs.js`、界面、生成）本来就把查不到的 id 当「没绑」，写入侧现已归一化（`a07ec71`）→ 不再额外在删除端改别的表（否则删一个素材会连带写一批 shot 行；回滚也要跟着成批恢复）。
- **`refs.js` 的 `hasImage` 只看人物/场景/道具的**原图**，不看服装/年龄变体的图**：要触发误报得同时满足「角色没有 `image_path`」且「它的变体有图」，而变体是图生图产物（必须拿角色图作参考才生成得出来）→ 实际上不可达，不改（避免为不可达状态改判定）。
- **素材名可以是纯空白**（`POST /assets` 只查 `!name`）：素材名不是业务键（分镜按 id 绑定、章节才按标题归属），空白名只影响观感 → 不改。
- 沿用前面几轮的判定（不再重复理由）：`PUT /api/config` 覆盖语义、`shots/zip` 空集 500、`mergeVideos` 的 volume、`music/apply` 路由层不校验 `music_id`、章节/分镜 PATCH 无 `activeJobOf`、`comfyui/test`+`llm/test` 的 SSRF 面、`DELETE /references/:rid` 连带删关联素材、`withRetry` 死代码、`abortFlags` 只增不减、`installSkillsFromZip` 不回滚、JSON 请求体无显式上限、`GET /files/*` 不限体积、回滚不删磁盘媒体、`/export` 与整片合并不响应停止、`withWriteContext` 不是数据库事务（因此只在能前置校验的地方前置校验）。
- 仍然成立的一条**有意为之**：不在写入端强制「变体的父角色必须在本镜」，只在前端选择器收敛可选范围（`f3c29a4`）。

### 第九～十轮验证口径

- 单测：`node --test "tests/*.test.mjs"` **176/176**（第八轮 155 → 第九轮 +18 → 第十轮 +3）。新增用例覆盖：`Assets.update` 离开变体分类清父（含变体互改保父、非变体→变体仍拦、只改名字不动存量）、项目删除的「先停任务再删」（源码守卫：`stopJob` 必须早于 `Projects.remove`、`running|queued` 都要停、执行中要 `interruptTask`、响应带 `stopped`）、分镜绑定归一化（错类/不存在/跨项目丢弃、只改别的字段不动存量、`usageOf` 的 `audio_ids` 引用改用真实语音素材）。
- 反向验证（撤掉修复即翻红）：`Assets.update` 的 `m.parent_id = ''` 改成 `void 0` → 新用例失败；把归一化的早退条件反转 → 新用例失败；路由里 `stopJob(j.id)` 换成 `void 0` → 源码守卫失败。三条均还原后 176/176。
- 实机探针（dev 实例、端口 4600）：新增 `ic-r10-delstop-probe.mjs` **11/11**（用 `node:sqlite` 往真实 `data/ic.db` 插 1 条 `running` + 1 条 `queued` + 1 条 `done` 假任务 → `DELETE /projects/:id` 回报停掉前两条、不含 `done`；项目 404、jobs 行清零、项目目录删除）；新增 `ic-r10-bind-probe.mjs` **11/11**（整章写 storyboard：错类/不存在/跨项目 id 不进库，`audio_ids` 只留语音；`PATCH` 整条数组含悬空 id → 200 且只剩有效 id；只改 `camera` 不动存量绑定；临时项目清理）；`ic-r8-parent-probe` 扩到 **31/31**（新增「改分类离开变体 → 父指针清空，且删角色不再级联删掉这条已改成道具的素材」）。
- 回归（全部重跑，全绿）：`ic-audit-e2e` **88/0**、`ic-refguard-e2e` **15/0**、`ic-r4-probe` **6/0**、`ic-r4-probe2` **6/0**、`ic-malformed-probe` **5/0**、`ic-r6-llm-probe` **5/0**、`ic-r7-upload-probe` **20/0**、`ic-r7-skills-probe` **5/0**、`ic-range-probe` **失败 0 项**、`ic-r9-skills-probe` **7/0**、`ic-r9-rollback-probe` **11/0**。第十轮改完 `lib/core/db.js` 后**重启过一次 dev 实例**（`server.js` 自身也 import `lib/core`，避免进程里留着旧副本）。
- 一处如实记录：探针造的「活动任务」是直接播的 DB 行（不真跑渲染），因此 `interruptTask` 在本机没有监听 8188 时是连接被拒 + 被 `try/catch` 吞掉——「删项目会停掉活动任务」的**判定链**由探针验证，`interruptTask` 的**效果**沿用 `/stop`/`/cancel` 已有的实机结论。



## 十八、第十一轮：停止/取消改按「谁真的占着 ComfyUI」判定（2026-10-16，dev7）

第九、十轮修的是「写入端静默无效」；本轮的问题是**判据本身用错**：把「任务状态是 `running`」当成「该任务占着 ComfyUI」，于是四条停止/取消路径都变成了对**全局** `/interrupt` 的无条件调用。

行内任务（`runInlineJob`：`llm` 参考图分析、`export` 按章导出）在请求内同步执行、不进渲染闸门、也没有任何代码读它的停止标记，但它的状态同样是 `running`。而 `/interrupt` 是 ComfyUI 全局的——打断的是「当时正在执行的那一项」。渲染闸门按**全局**槽位串行（本地默认 `videoConcurrency=1`），所以那一刻正在跑的很可能就是**另一个项目**的整片生成：取消一条参考图分析任务，会把别人正在生成的镜头打断成 `failed`。

### 修掉的（1 个原子提交，覆盖 4 条路径 + 闸门）

| 提交 | 级别 | 问题 | 修复 |
|------|------|------|------|
| `3092334` | 高 | **取消/删除行内任务会误杀别人的渲染任务**：`POST /jobs/:jobId/cancel`、`DELETE /jobs/:jobId`、`POST /stop`、`DELETE /projects/:id` 都用「状态是 running」决定是否 `/interrupt`（第四条是上一轮新加的，照抄了同一判据）。行内任务不占槽位，打断的是当时真正在跑的渲染任务（很可能是别的项目的整片生成）→ 那条任务以 failed 收场。附带两处「假成功」：对行内任务取消会返回 `ok` 但它照样跑完（没人读停止标记）；删除行内任务记录会把「还在同步执行」的任务变成看不见的孤儿（记录没了、活照跑，产物照写） | 闸门（`job-runner.js`）新增 `holdsRenderSlot(jobId)`：`gate.holders` 集合与槽位同挂 `globalThis`，`acquire()` 里加、`finally` 里删，就是「此刻谁真的占着 ComfyUI」。四条路径全部改成「确有任务占槽位时才 `/interrupt`」；`/cancel` 与 `DELETE /jobs/:jobId` 对行内任务**如实返回 409**（界面本来就不给取消按钮，API 此前却返回 ok，属假成功）；`DELETE /jobs/:jobId` 也因此不再删掉正在同步执行的记录 |

### 本轮核对过、判定「不改」的项

- **行内任务仍然不响应停止**：`/export` 的 ffmpeg 合并没有中断点，参考图视觉分析是一次 LLM 调用，给它们加取消要改 ffmpeg 子进程与 LLM 客户端两层。本轮只保证「取消它不会伤到别人」，不扩这一层（与既有的「`/export` 与整片合并不响应停止」同属一条已知限制）。
- **界面 `ProjectView.jsx` 的 `CANCELLABLE` 是一份手写清单**（10 个走闸门的类型，恰好与 `Jobs.create` 的 12 个类型一一对应）。没有改成「后端下发可取消标记」：后端现在已是权威判据（界面若漂移，最多少一个按钮；后端若漂移，会误杀别人的任务），改造成本不值。
- **删项目时若只有行内任务在跑，它们不会被停**（停不掉）：导出可能因项目目录被删而失败，归入上面那条已知限制。

### 第十一轮验证口径

- 单测：**178/178**（上一轮 176 + 新增 2）。新增用例：① `holdsRenderSlot` **行为**用例——持有槽位期间为真、排队中为假、释放后为假、`jobId` 缺失不抛错、`gate.holders` 确实挂在 `globalThis` 上；② 四条路由的**源码守卫**——必须用 `holdsRenderSlot` 判定、判断必须发生在 `/interrupt` 之前、行内任务必须如实拒绝。
- 反向验证（两条，各自只翻红对应用例，均还原后 178/178）：① 闸门 `acquire()` 不再把 `jobId` 记进 `holders` → 行为用例红；② 取消路由退回「裸 `running` 就打断」→ 源码守卫红。
- 实机探针：新增 `ic-r11-inline-cancel-probe.mjs` **18/18**。手法补上了上一轮欠的那块观测能力：`config.json` 的 `comfyui.baseUrl` 本来就是 `http://127.0.0.1:8188`，探针在该端口起一个**只记录请求的存根**（本机此刻没有 ComfyUI 在跑，**不动任何配置**），于是「谁被 `/interrupt`」变成可数的证据——新代码下取消行内任务、删除行内任务记录、`/stop`、删项目四条路径一个 `/interrupt` 都没有；随后把取消路由**临时改回旧判据**再打一次同一操作，存根立刻收到 `POST /interrupt`（返回码也从 409 变回 200），旧代码误杀别人的渲染任务被实机复现；改回后再次恢复 409 且不再打断。
- 回归：上一轮全套探针重跑全绿（audit-e2e 88/0、refguard 15/0、r4 6/0、r4-probe2 6/0、malformed 5/0、r6-llm 5/0、r7-upload 20/0、r7-skills 5/0、range「失败 0 项」、r8-parent 31/0、r9-skills 7/0、r9-rollback 11/0、r10-delstop 11/0、r10-bind 11/0）。改到 `lib/agent/job-runner.js` 后重启过 dev 实例；`gate.holders` 用 `gate.holders = gate.holders || new Set()` 补默认值，兼容 dev 模式下被复用的旧 `gate` 对象（上一轮留的实例不会再出现「有槽位、无持有者集合」）。



## 十九、第十二～十三轮：干净轮 + 确认轮（2026-10-16，dev7）

第十二轮（新一轮审计）与第十三轮（确认轮）**都没有发现需要修复的项**。按前几轮的约定把「核对过、判定不改」的新增项记录下来，免得下一轮重复挖。

### 第十二轮核对过、判定不改

| 位置 | 核对的事 | 判定 |
|------|----------|------|
| `chapters/[cid]/route.js` PATCH | 章节标题是**业务键**（分镜按 `shots.chapter` = 章节标题归属），而 `Chapters.update` 自己**不级联**改名 | 不改：级联在**路由层**（`withWriteContext` + `tx` 内逐条 `Shots.update` 把该章分镜一起改名并留档，`before.title !== updated.title` 才算改名）。已覆盖唯一的改名入口——内置 Agent 没有改章节标题的工具，界面「编辑章节」走的也是这条 PATCH。**注意**：日后若给 `Chapters.update` 添别的调用方能改 `title`，必须同时补级联 |
| `lib/agent/tools.js` 章节工具 | 有没有工具能绕过路由改 title | 不改：只有 `list_chapters` / `set_storyboard` / `set_chapter_music` / `generate_chapter_videos` / `apply_chapter_music`，`Chapters.update` 在 Agent 里只写 `music_prompt` / `music_path` |
| `assets/[aid]/upload` POST | 全仓唯一一处 `Assets.update` 却**没有** `withWriteContext` 的写路由 | 不改：它写的 `image_path` / `audio_path` / `voice_ref` / `status` 都在 `VOLATILE.asset` 里（渲染产物，本就不进变更日志）；只有 `source: 'uploaded'` 会"漏"一次留档，影响仅是「回滚不会把 source 改回 generated」，无业务后果 |
| `activeJobOf`（`/run`、`/stages`、删章节、删分镜、整章重写分镜） | 判据是「本项目有 running/queued 任务」，**行内任务**（`llm` 参考图分析、`export` 按章导出）也算 | 不改（保守过度拦截）：`/run`、`/stages` 用宽口径是对的（本地 27B 权重与行内 LLM 任务会抢显存）；内容写入那三条在用户刚好导出/传参考图时会被挡几秒到几十秒，代价是「重试一次」，而放宽要先定义「哪些任务会回写内容行」的清单，引入的风险比收益大 |
| `lib/core/runninghub.js` | `interruptTask(cfg)` 无 taskId 时云端是空操作 | 不改（既有设计）：RunningHub 的取消靠 `generate` 内部轮询到 `isAborted` 再 `runninghubCancel(taskId)`。第十一轮修的「取消行内任务误杀渲染任务」在云端本来就不成立（空操作吞掉），那条修的是原生 ComfyUI |

### 第十三轮核对过、判定不改

- `server.js` 的 `/files/*`：`path.resolve` + `path.relative(PROJECTS_DIR, abs)`，`..` 开头/绝对路径/空一律拒 → 目录穿越（含 `%2e%2e` 与 `GET //`）都被挡住；仍保留既有限制「不限返回体积」。
- `lib/ws.js`：广播函数与停止注册表、渲染闸门同一手法挂 `globalThis`；`broadcast` 无广播者时空转，不抛。
- `shots` 的 POST / PATCH：`idx` 是章内唯一键——显式给 `idx`（含「改 idx 顺带换章」时按**目标章节**判）都要过 `idxTakenBy`；`chapter` 必须已存在，否则 400，不产出界面上看不见的孤儿分镜。
- `PUT /api/projects/:id/context`：`{key,content}` 与 `{bible,style,continuity}` 两种入参都支持，`continuity` 走追加式 JSON 数组；键来自 `lib/shared` 的 `CONTEXT_KEYS`（单一事实来源），落盘 `context/*.md` 与 DB 同步。
- `lib/core/comfyui.js` 的 WS `onmessage`：`JSON.parse` 在 `try/catch` 内（畸形帧不会带崩进程）；`llm.js` 的 JSON 抽取失败由调用方重试兜底。

### 确认轮（第十三轮）验证口径

- 单测 **178/178**（与第十一轮一致，两轮无代码改动）。
- 全套探针重跑全绿：audit-e2e 88/0、refguard 15/0、r4 6/0、r4-probe2 6/0、malformed 5/0、r6-llm 5/0、r7-upload 20/0、r7-skills 5/0、range「失败 0 项」、r8-parent 31/0、r9-skills 7/0、r9-rollback 11/0、r10-delstop 11/0、r10-bind 11/0、r11-inline-cancel 18/0。
- 前端整图编译：`GET /` **200**（24524 字节）。
- 临时项目清理：`ic-cleanup-projects.mjs` 前缀补 `IC-R11-` 后实删 **14/0**，真实库只剩用户项目「白衣审判」。
- 十二、十三两轮均无代码改动 → `dev7` HEAD 停在第十一轮的 `f6e5cc0`（本轮共 2 个提交），仍无 upstream、未推送。



## 二十、收尾决定（2026-10-16，dev7）

三件挂起的事由审计方定案如下。

### 1. `seed` 从外部可写白名单移除（`7217488`，**改了代码**）

`seed` 是渲染参数/产物，不是内容：

- `generateShotVideo`（tools.js）每次渲染都现取一个随机种子写回行上；
- 整条渲染链路**从不读** `shots.seed` 当输入——唯一带 `seed` 形参的 `runI2iEdit`，四个调用方没有一个传它；
- 它又在 `changelog` 的 `VOLATILE.shot` 里（渲染回写不刷日志），所以外部写进来的值既不进变更日志、回滚也恢复不了。

结论：外部写 `seed` 下一次渲染就被覆盖 —— 「接口答应得下、实际静默无效」，与 `status` / `video_path` 同口径拒收。要点：

- `SHOT_NUMBER_FIELDS` 去掉 `seed`，删掉它的专用归一化分支；三条外部写入路径（`POST /shots`、`PATCH /shots/:sid`、`PUT /storyboard`）统一 400「不接受字段 seed」。
- 内置 Agent 不受影响：`set_storyboard` / `update_shot` 的 schema 里从来没有 `seed`，它们也不走 `pickShotFields`（该白名单只服务外部写入 API）；界面只展示 seed、不可编辑。
- 顺手修掉一处**错报**：数字字段循环末尾原本是「兜底分支」，任何白名单里的数字字段走到最后都会被按 `duration` 的区间校验 —— 把 seed 放回白名单做反向验证时，`seed=123456` 报的是「duration 必须在 1~15 秒之间」。现在 `duration` 显式判名（日后往 `SHOT_NUMBER_FIELDS` 加字段要补显式分支）。
- **若日后要「钉住种子复现」，那是功能变更**：先让渲染读它（非 0 沿用），再把它从 `VOLATILE` 拆出来（否则钉了也不会被日志/回滚看见）。
- 文档同步：`ic-writer` 技能的「分镜可写字段」清单去掉 `seed`，并把 `seed` 并入「产物字段不可写」。**技能源在本仓库的 `harness-skills/ic-writer/SKILL.md`**（`scripts/install-writer-skill.mjs` 从那里装到 `~/.agents/skills/ic-writer/`）——原先这句写成「不在本仓库、不随提交走」是错的，导致本轮只改了 `~/.agents` 那份、仓库那份仍把 `seed` 列为可写，重跑安装脚本就会把技能回退成错契约（§二十一 修复 9 已把两份对齐）。

验证：单测 **178/178**（断言精确到错误文案——只数条数会被上面那种错报蒙混过去）；反向验证「seed 放回白名单 → 该用例翻红，还原 → 全绿」；实机探针 `ic-seed-reject-probe.mjs` **13/13**（三条写入路径带 seed 均 400 且文案精确、同一条分镜写合法字段仍 200 且落库、`seed` 保持 0 既没被清空也没被伪造、整章重写被拒后原分镜还在）。

### 2. `ic-mkjob.mjs` 保留

它不是孤儿：`ic-audit-e2e.mjs` 依赖它造「运行中/排队中」任务，第 10、11 轮的探针也沿用同一手法（直写 `data/ic.db` 的 jobs 表，不触发任何生成）。它属于探针工具链，留在 `Temp/opencode`，不进仓库。

### 3. `dev7` 暂不推送

`origin` 是你的 fork（`happymy/infinite-creation`），`upstream` 是上游（`SwotAtmk/infinite-creation`）。本轮没有 PR/评审对象，分支也还没收敛成可交付状态，推送只是多一次公开副作用。要推时说一声，执行 `git push -u origin dev7`（本会话不自行推送）。



## 二十一、第十四轮：分支整体审计——`dev7` 相对 `origin/main` 的 130 个提交有没有改坏业务逻辑（2026-10-16，dev7）

范围：`934ee07`（= `origin/main`，也是 `merge-base(dev7, main)`）→ `dev7`（`0a16f38`），**130 个提交、58 个文件**（代码 +2695 / −492；不含 docs 与 tests）。方法：把累计代码 diff（`git diff -U6`，5959 行）切成 6 段，逐 hunk 读，**每条候选都回到源码复核调用方**（界面 / 内置 Agent / 既有数据），确认后再动手；改完对每条真问题做反向验证（把改动注回去 → 对应用例翻红 → 还原 → 全绿）。

结论：**这一批改动没有把任何合法流程改坏**（下面「判定不改」项都是既有取舍或既有缺陷，不是 dev7 引入的），但**新加的逻辑里有 9 处会挡住合法流程、或自身状态不一致**，已修。

### 修掉的（9 项）

1. **`＋新增章节` 被自己的唯一性校验堵死**（`db.js`）：自动标题直接拼 `'第' + seq + '章'`，而 `seq` 只看现有最大序号 —— 用户把某章改名成「第3章」后（maxSeq 仍是 2），新增章节又拼出「第3章」→ `DUP_CHAPTER_TITLE`。界面上「＋新增章节」固定发空标题、又没有填标题的入口，用户只能先去改名才能建章。改为 `autoChapterTitle()`：往后找第一个没被占用的「第N章」。
2. **只改素材绑定也会被「历史超速台词」挡住**（`shot-write.js` `validateShotContent`）：跨字段校验（台词速度、说话人数）原先**无条件**执行，拿库里旧台词重算 —— 历史遗留 / 外部写入的超速行**整行不可编辑**，界面上连解绑都做不了（绑素材只发 6 个 `*_ids` 也 400）。改为只在本次真的改了依赖字段时校验（速度看 `dialogue`/`duration`，说话人看 `dialogue`），与内置 Agent `update_shot` 同口径。`chapter` 归属校验保持无条件（清空归属会让分镜从章节视图与统计里消失）。
3. **`set_storyboard` 的工具描述与自己的校验对不上**（`tools.js`）：描述写「chapter 传章节号」，校验只认章节标题或 id → 模型照描述传 `"1"` 会让**整批**分镜被拒（一条都不落库）。描述改为「chapter 传章节标题或章节 id（先用 `list_chapters` 看本项目章节）」。
4. **资产图阶段顺序反了，换装/年龄兜底首次必失败**（`stages.js`）：兜底是图生图，`hChangeOutfit`/`hChangeAge` 在角色 canonical 图不存在时直接抛「角色参考图不存在」，而它原先排在 `generate_assets_batch` **之前** → 新项目首次跑资产图阶段时每个变体都失败（只落进 notes），要再跑一次才生效。改为先批量出图、`isAborted` 检查后再兜底。
5. **「重做」之后再也回滚不掉那次改动**（`changelog.js`）：回滚一条「回滚日志」= 重做，但原始日志的 `reverted_by` 没被清掉 → 之后单条 / 全量回滚都会把它当「已被回滚」跳过（用户看到「回滚成功」而数据没变）。重做时清掉 `revert_of` 指向那条日志的 `reverted_by`。
6. **运行中的行内任务仍显示「删除」按钮**（`ProjectView.jsx`）：后端对「运行中且不占渲染槽位」的行内任务（llm 参考图分析 / export 按章导出）明确回 409（停不掉，删记录只会留下看不见的孤儿），而界面给所有任务都渲染删除按钮 → 用户点了必然报错。改为与 `CANCELLABLE` 同一判据：运行中的行内任务不渲染删除。
7. **数组字段塞对象被静默变成 `"[object Object]"`**（`shot-write.js` `pickShotFields`）：`*_ids` 那条链路会被 db 层当无效 id 丢掉（回 200 却没写进去），`refs` 那条把垃圾字符串存下来。改为当场 400（与「白名单外字段一律报错」同口径）。
8. **两条写入路径的默认时长不一致**（`tools.js` `hUpdateShot` 写死 `|| 8`，而 `SHOT_DURATION_DEFAULT = 5`）：历史行 `duration` 为空时，同一行在外部 API 与内置 Agent 里按不同上限判台词。统一取 `SHOT_DURATION_DEFAULT`。
9. **技能文档漂移**（`harness-skills/ic-writer/SKILL.md`，是 `scripts/install-writer-skill.mjs` 的安装源）：仓库内那份仍把 `seed` 列为可写、项目 `PATCH` 那行还是旧措辞，而 §二十 只改了 `~/.agents` 那份 —— 重跑安装脚本会把技能回退成错契约。两份现已逐字一致，并补上「章节重排必须给本项目全部 id」「章节改名请按 `batch_id` 回滚」「数组元素必须是字符串」。

### 本轮核对过、判定「不改」的项

- `activeJobOf` 把 `queued` 也算活动任务 → 本项目任一 running/queued 任务（含不碰分镜的 asset-image / voice-design / music）都会挡住删章节 / 删分镜 / 整章重写；排队任务最多被挡到队列超时。第 11、12 轮已判定「保守但可接受」，本轮复核仍不改（排队任务醒来后确实会写这些行，删了会留孤儿）。后续若要细化，应按「任务类型是否真的写分镜」判。
- 单条回滚「章节改名」日志**不**连带还原同批的分镜（分镜仍指向旧标题）→ 不改代码，改为写进技能文档：按 `batch_id` 回滚。
- `VOLATILE.chapter` 含 `music_path` / `music_prompt_used`：`/music/apply` 这种用户级操作也不进变更日志（与渲染链路写同一批字段，无法区分）→ 已知缺口，记录在案。
- 视频阶段逐章 try/catch：部分章节合并失败仍以 `done` 收尾（detail 里列出失败章节），只有全失败才报失败 —— 第 8 轮既定取舍。
- 行内任务（llm / export）不可取消、不可删除（409）—— 第 11 轮既定；本轮只让界面别渲染那个必然报错的按钮。
- `dialogueSpeakerNames` 对「甲，乙：台词」这类标签不拆分（只记一条可观测提示）—— 拆逗号会误伤台词正文，第 9 轮既定。
- `db.js` 只设 `PRAGMA journal_mode = WAL`、没有 `busy_timeout`：Next 按路由分包 → 多份 `DatabaseSync` 连接同一文件，并发写入理论上可能 `SQLITE_BUSY`（既有情况；本分支事务包住更多语句、窗口更长）。建议后续加一行 `PRAGMA busy_timeout`，本轮不改（非 dev7 引入）。
- `shots.refs`（`references` 字段）写入后只有 `Assets.usageOf` 扫描消费、渲染链路不读它 —— 既有设计，非本轮引入。

### 顺带：README 补上「外部写入」的用法与限制（面向用户）

仓库根 `README.md` / `README_EN.md` 各新增一节「让 Claude Code / opencode 帮你写内容（外部写入）」：三步用法（`pnpm run install:ic-writer` → `pnpm run dev` → 对工具说人话）、能写 / 不能写对照表、限制（零鉴权只连本机、`running` 时别写、分镜业务校验、只走 HTTP API、回滚只恢复 DB 行不删磁盘文件），并把 `context` / `storyboard` / `shots` / `logs` / `logs/rollback` 补进「API 一览」表。技能目录新增 `harness-skills/ic-writer/README.md`（给人读；`SKILL.md` 仍是给 Agent 的契约，两份随安装脚本一起复制到技能目录）。三份文档都不含绝对路径，换机器可直接照做。

### 第十四轮验证口径

单测 **184/184**（较上轮 +6 条回归：重做后可再回滚 / 只改绑定不被旧台词挡 / 自动标题避让 / 数组含对象报错 / 两条路径同一份默认时长 / 工具描述与校验同口径 + 资产图阶段顺序 + 行内任务不渲染删除）；5 处代码修复**逐条反向验证**（注入原缺陷 → 对应用例 `fail=1` → 还原 → 全绿）。改 `lib/core`、`lib/agent` 后重启实例，既有 **16 支探针全部重跑全绿**（`ic-audit-e2e` 88/0、`ic-refguard-e2e` 15/0、`ic-r4-probe` 6/0、`ic-r4-probe2` 6/0、`ic-malformed-probe` 5/0、`ic-range-probe` 失败 0、`ic-r6-llm-probe` 5/0、`ic-r7-upload-probe` 20/0、`ic-r7-skills-probe` 5/0、`ic-r8-parent-probe` 31/0、`ic-r9-skills-probe` 7/0、`ic-r9-rollback-probe` 11/0、`ic-r10-delstop-probe` 11/0、`ic-r10-bind-probe` 11/0、`ic-r11-inline-cancel-probe` 18/0、`ic-seed-reject-probe` 13/0），并新增 `ic-r14-fixes-probe.mjs` **24/24** 专测本轮修复（直写库造「历史超速行」→ 只发 6 个 `*_ids` 应 200、改台词/时长仍 400、显式空 chapter 仍 400；数组塞对象 400 且库里无 `[object Object]`；「第3章」被占后空标题建章得「第4章」；回滚 → 重做 → 再回滚同一条 create 日志 `applied=1` 且分镜真的消失）。`GET /` 200（长度 24524，与前轮一致）确认 JSX 改动不破坏编译；临时项目清理 7/0，真实库只剩「白衣审判」。


