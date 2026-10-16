---
name: ic-writer
description: 把内容写进一个正在运行的 infinite-creation 实例（本地漫剧/短视频创作 Agent）：新建项目、写小说原文、写剧本、写分镜、写人物圣经/风格，也能改写**已经生成过的** LLM 产物。只走它的文本写入 API：读写一律通过 HTTP API，不直连数据库/文件；不触发生图/生视频/配音/配乐/导出，不删除项目。触发场景：用户要把小说/剧本/分镜「写进 infinite-creation」「导入项目」「批量建项目」「写入分镜表」，或要改写/覆盖已有项目里已生成的章节、剧本、分镜、提示词。不负责也无法触发生成链路（那些在应用界面里跑）。
---

# infinite-creation 写入桥（harness → 项目文本内容）

外部 Agent 通过 HTTP API 把**文本内容**写进一个已在运行的 infinite-creation 实例。
只写文字：项目、小说原文、剧本、分镜、人物圣经/风格、素材提示词。既能写新项目，也能**改已生成的 LLM 产物**。
**绝不触发生成**（图片/视频/语音/音乐/导出），**绝不删除项目**，**只经 HTTP API 读写**（不直连 `data/ic.db`、不手改 `data/` 与 `config.json`）。

## 铁律（先读完再动手）

1. **只写文本，不触发生成**。不要调用任何生成/渲染/导出接口（清单见下节）。图片、视频、语音、音乐、成片导出全部由用户在应用界面里启动；你只负责把「写什么」落进去。
2. **绝不删除项目**。整个流程里不要调用 `DELETE /api/projects/:id`。日志的唯一清理时机就是用户在界面手动删项目。回滚接口也会拒绝「回滚掉项目创建」。
3. **先读后写**。每次写之前先 `GET` 现在的状态（章节标题、分镜 idx、已有内容），写完再 `GET` 回读校验。用户可能同时在界面上改；要覆盖已有内容时，先读回来确认自己要覆盖的就是它。
4. **长文本一律走文件，不要内联进命令行**。Windows 上 `cmd.exe` 的 `%*` 会把裸换行当成命令结束，静默截断你传的小说。用 Node 读文件拼 JSON，或 `curl --data-binary @body.json`。
5. **分镜按章节整体写**（`PUT …/storyboard`），不要一条条乱序插；整章一次调用 = 一个批次，写坏了整批回滚。
6. **一次写入就是一个批次**。同一个 API 调用产生的所有变更共享 `batch_id`，可整批回滚。
7. **项目正在跑任务时不要写**。先 `GET /api/projects/:id` 看 `status`：是 `running` 就等（或让用户先停任务）——运行中的任务正持着当前分镜行，删除类写入会被直接拒（409），内容类写入也可能被任务用旧数据覆盖，最后「成片与分镜表对不上」。
8. **写进去的分镜要能过应用的业务校验**，否则接口直接 400：`duration` 1~15 秒；`dialogue` 字数 ≤ `duration × 5.5`（超速会被 TTS/H3 压成听不清的模糊声）；单个分镜说话人 ≤ 2（每说话人一段参考音色）；`resolution` ∈ `360P/480P/720P/768P/1080P/2K/4K/custom`（空串 = 继承项目设置）；`aspect_ratio` ∈ `1:1/2:3/3:2/3:4/4:3/9:16/16:9/21:9`；`idx` 从 1 起、同章内不重复。项目级同名两项（`POST /api/projects`、`PATCH /api/projects/:id`）用**同一份枚举**：分镜会继承项目设置，项目这一层写错会让整个项目在渲染阶段才炸，同样 400。
9. **只能走 HTTP API 读写，不许直连数据库/文件**。项目数据一律通过 `{base}/api/...` 读和写：**禁止**打开 `data/ic.db`（`node:sqlite`/`sqlite3`/任何 DB 客户端，**读也不许**）、**禁止**直接改 `data/` 下的文件或 `config.json`。绕过去就没有变更日志（不可回滚、`source` 记不上、批次不成立），详见下一节。

## 只走 API：不碰数据库、文件与配置

本技能的**唯一**读写通道是 `{base}/api/...`。即使 `data/ic.db` 就在手边，也不要打开它——绕过去等于把本技能赖以成立的三样东西一起毁掉：每次变更的原始行快照、`source`（这条改动是谁写的）、`batch_id`（整个操作可整批回滚）。

| 禁止 | 为什么 |
|------|--------|
| 打开 `data/ic.db`（`node:sqlite` / `sqlite3` / 任何 SQL 客户端），**只读也一样禁** | 直连不经过 db 层埋点 → 没有日志、不可回滚、`source`/`batch_id` 记不上，回滚账本当场失真；而且应用与内置 Agent 一直在写这个库（WAL 单写者），外部再插一个写者会撞锁（`SQLITE_BUSY`），甚至改到任务正在用的行 |
| 直接读写 `data/projects/**`（项目目录、`context/*.md`、媒体文件） | 文件与 DB 行必须一起更新（`PUT …/context` 会同时落 `context/*.md`），手改文件只会造出「界面里一套、盘上一套」。参考图与媒体文件的增删也只有上传接口一条路 |
| 改 `config.json`、`data/*.log`，或往 `change_logs` 里塞记录 | 配置与运行状态不属本技能职责；伪造日志 = 毁掉唯一的回滚依据 |
| 用「只读连接看一眼」代替 API 读 | 需要什么就用 API 读：`GET …/projects/:id`、`…/chapters`、`…/shots`、`…/assets`、`…/logs`。API 里没有的字段本来也不该由你判断 |

API 读不到、或改不了的 → **直接告诉用户**缺什么，不要自己去库/文件里补（接口没提供的能力就不在本技能范围内，例如删除项目）。

## 禁止调用的接口（会把任务推进生成链路）

| 路径 | 为什么禁止 |
|------|-----------|
| `POST /api/projects/:id/run`、`POST …/stages` | 启动 LLM/生图/音色/视频阶段流水线 |
| `POST …/shots/:sid/regenerate`、`POST …/chapters/:cid/regenerate` | 重新生成分镜/章节 |
| `POST …/assets/:aid/generate`、`…/design-voice`、`…/change-outfit`、`…/change-age` | 生成素材图 / 音色 / 换装 / 年龄变体 |
| `POST …/music`、`…/music/apply` | 生成并应用背景音乐 |
| `POST …/export`、`GET …/exports/.../download` | 合成导出成片 |
| `POST …/stop` | 停止任务（属运行控制，不在本技能职责内） |
| `DELETE /api/projects/:id` | 删除项目（**永不调用**） |

写文本时若发现「这个字段要等生成才有值」（如 `shots.status`、`video_path`），直接跳过——那是生成链路的产物，不是你要写的东西。


## 前置

- 服务地址：环境变量 `IC_BASE_URL`，默认 `http://127.0.0.1:4600`。
- **只对本机的 127.0.0.1 使用**：该实例零鉴权，能读项目全文、改内容、回滚。用户若把 `server.host` 配成 `0.0.0.0`，它就是一台对局域网开放的写入端点——遇到这种配置先提醒用户改回本机。
- 探活：`GET {base}/api/health` 期望 `{"ok":true}`。
- 运行环境有 Node ≥ 22（本项目前置依赖），所以**推荐用 `node -e` 发请求**：跨 shell 一致、不用跟引号搏斗。

```bash
# 探活
node -e "fetch(process.env.IC_BASE_URL||'http://127.0.0.1:4600'+'/api/health').then(r=>r.json()).then(o=>console.log(o))"
```

以下示例统一用这个辅助写法（PowerShell / cmd / bash 通用）：

```bash
# 读：列项目
node -e "fetch('http://127.0.0.1:4600/api/projects').then(r=>r.json()).then(o=>console.log(JSON.stringify(o,null,2)))"

# 写：body 从文件读（长文本必用）
node -e "const fs=require('fs');fetch('http://127.0.0.1:4600/api/projects/PID/chapters',{method:'POST',headers:{'content-type':'application/json'},body:fs.readFileSync('body.json')}).then(async r=>console.log(r.status,JSON.stringify(await r.json())))"
```

## 接口速查

| 方法 | 路径 | body | 说明 |
|------|------|------|------|
| GET | `/api/health` | — | 探活 |
| GET | `/api/projects` | — | 项目列表（id/name/status/计数） |
| POST | `/api/projects` | `{name, idea?, style?, novel?, video_resolution?, video_aspect_ratio?, target_duration?}` | **新建项目**；自动创建「第1章」并承载 `novel` |
| GET / PATCH | `/api/projects/:id` | PATCH 只认 `name/novel/idea/style/video_resolution/video_aspect_ratio/video_width/video_height/target_duration/enable_bgm`，其余字段（含 `status`、`context`）一律 400 | 项目属性。`status` 是流水线状态、`context` 走下面的 `PUT …/context`（同时落盘），都不从这里写 |
| PUT | `/api/projects/:id/context` | `{key:'bible'\|'style'\|'continuity', content}` 或 `{bible?, style?, continuity?}` | 人物圣经/风格/连续性（同时落盘 `context/*.md`） |
| GET | `/api/projects/:id/chapters` | — | 章节列表（含 `script`、分镜计数、生成状态） |
| POST | `/api/projects/:id/chapters` | `{title?, novel?, script?}` | **新增章节**（小说原文按章写） |
| PATCH | `/api/projects/:id/chapters` | `{ids:[...]}` | 按数组顺序重排章节 |
| PATCH | `/api/projects/:id/chapters/:cid` | `{title?, novel?, script?}` | 改章节；改标题会同步迁移该章分镜 |
| DELETE | `/api/projects/:id/chapters/:cid` | — | 删章节（级联删该章分镜，可整批回滚）。**任务运行中 409** |
| PUT | `/api/projects/:id/chapters/:cid/storyboard` | `{shots:[…], replace?}` | **整章写分镜**（默认 `replace:true` 先清空该章），单次 ≤500 条。**任务运行中 409**；`replace:false` 追加时镜号自动接在该章现有最大 `idx` 之后 |
| GET / POST | `/api/projects/:id/shots` | POST 见下 | 列 / 建单个分镜 |
| PATCH / DELETE | `/api/projects/:id/shots/:sid` | PATCH 见下 | 改 / 删单个分镜（删除在**任务运行中 409**） |
| GET | `/api/projects/:id/logs` | 查询串 `entity/action/source/limit/offset` | **变更日志**（回滚依据） |
| POST | `/api/projects/:id/logs/rollback` | `{log_id}` \| `{batch_id}` \| `{since_ts}`，可加 `force:true` | **回滚** |
| GET | `/api/projects/:id/assets` | — | 素材（人物/场景/道具/音色/音乐），只读为主 |

## 内容分层：别写错层

| 要写的东西 | 写到哪 |
|-----------|--------|
| 小说原文 | `chapters.novel`（一章一段，用 `POST/PATCH …/chapters`） |
| 剧本 | `chapters.script`（与 novel 并列的中间层；流水线不隐式消费它） |
| 分镜 | `shots`（`PUT …/chapters/:cid/storyboard`） |
| 人物圣经 / 风格 / 连续性 | `PUT …/context` |

**分镜可写字段**（白名单外一律 400 报错）：

```
chapter, idx, scene_name, camera, visual, dialogue, narration, sub_shots,
duration, seed, resolution, aspect_ratio, video_prompt,
character_ids, scene_ids, prop_ids, costume_ids, age_ids, audio_ids, references
```

`status / error / video_path / video_prompt_used / prompt_id` 是生成产物，**不可写**（防伪造「已生成」）。
`resolution` / `aspect_ratio` 只接受枚举值（见铁律 8）；`duration` / `idx` 有区间约束。

## 改写已生成的 LLM 产物

同一个写入 API 也用于**修正已经生成过的内容**——正是本技能的常见用途：

| 想改的东西 | 怎么做 |
|-----------|--------|
| 已生成章节的小说/剧本 | `GET …/chapters` 拿 `cid` → `PATCH …/chapters/:cid {novel?, script?}`（整段覆盖） |
| 已生成的分镜正文/提示词 | `PATCH …/shots/:sid {visual, dialogue, camera, sub_shots, video_prompt, …}`；或整章重写 `PUT …/storyboard` |
| 已生成的人物圣经/风格 | `PUT …/context {key:'bible', content:'全文'}`（整段覆盖，continuity 为追加） |
| 已生成的素材提示词 | `PATCH …/assets/:aid {prompt?, negative_prompt?, description?, voice_desc?}` |

注意两点：

- **改了要连带说明影响**：分镜的 `video_prompt` 改过之后，应用下次跑渲染阶段会重出这条镜头（应用自己按 `video_prompt_used` 判定，不需要你触发）。这在预期内，但要在交付说明里告诉用户。
- **产物字段不可写**：`status / error / video_path / video_prompt_used / prompt_id` 一律 400 拒绝——它们是生成链路的结果，写不进去也伪造不出「已生成」。

## 典型流程

```bash
BASE=http://127.0.0.1:4600
# 0) 探活 + 建项目（记下返回的 id）
# 1) 写 3 章小说：chapters POST ×3（title 省略则自动「第N章」）
# 2) 写每章剧本：chapters/:cid PATCH {script:"..."}
# 3) 整章写分镜：chapters/:cid/storyboard PUT {shots:[{scene_name,camera,visual,dialogue,duration,...}]}
# 4) 回读校验：GET chapters → shotCount；GET shots → 逐条核对 idx/字段
```

分镜一条的示例：

```json
{
  "scene_name": "雨夜巷口",
  "camera": "中景缓推",
  "visual": "少女撑黑伞立于巷口，霓虹倒映积水，雨丝斜落",
  "dialogue": "（低声）你终于来了。",
  "narration": "",
  "sub_shots": "0-3s 推近；3-5s 停住",
  "duration": 5,
  "character_ids": [],
  "video_prompt": ""
}
```

## 回滚

```bash
# 看最近日志（谁改的、改了哪条、前后快照）
node -e "fetch('$BASE/api/projects/PID/logs?limit=20').then(r=>r.json()).then(o=>{for(const l of o.items)console.log(l.ts,l.source,l.entity,l.action,l.entity_id)})"

# 撤销一次调用：用那次的 batch_id 整批回滚
node -e "fetch('$BASE/api/projects/PID/logs/rollback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({batch_id:'BATCH_ID'})}).then(async r=>console.log(r.status,await r.text()))"
```

- 目标三选一：`log_id`（单条）/ `batch_id`（整批）/ `since_ts`（该时刻含之后全部内容变更）。
  - **整批回滚用 `batch_id`**：单条 `log_id` 只恢复那一条——回滚「删章节」时章节回来了，它的分镜不会（分镜各有自己的删除日志）。要「整个操作一起还原」就用那次的 `batch_id`。
  - `since_ts` 只覆盖内容变更，**不会反转此前的回滚**（要重做请显式回滚那条 `action='rollback'` 的日志）。
- **漂移保护**：那条变更之后又被改过时，接口回 **409** 且**不做任何改动**，返回 `conflicts`（当前值 vs 期望值）。确认要覆盖新改动才加 `force:true`。
- 返回 `skipped` 里的 `reason` 会说明为什么某条没回滚（例如「项目创建不可回滚（禁止删项目）」）。
- 逆操作整批跑在一个事务里：**中途失败 → 全部撤销**，返回 `applied: []` + `rolled_back: true`（不会留下「改了一半」的状态）。
- **回滚只恢复数据库行，不删磁盘上的图片/视频文件**；图片文件要重传。
- 回滚本身也记日志，所以「再回滚一次」= 重做。

## 交付前自检

- [ ] 全程只用了 `{base}/api/...`：没打开过 `data/ic.db`（只读也不行），没改 `data/` 下的文件与 `config.json`
- [ ] `DELETE /api/projects/...` 一次都没调用
- [ ] 没有调用任何生成/渲染/导出接口（run / stages / regenerate / generate / music / export）
- [ ] 写入前查过 `GET /api/projects/:id`，`status` 不是 `running`
- [ ] 每章 `novel`/`script` 都回读确认非空；被改写的内容与用户要求一致
- [ ] 分镜 `shotCount` 与预期一致，`idx` 连续、`chapter` 落在正确章节
- [ ] 所有写入都拿到了 2xx（400 说明有条分镜没过业务校验：时长/台词速度/说话人/枚举，已按铁律 8 修正）
- [ ] 需要时给用户一份「本次写入的 batch_id 列表」，方便一键回滚
