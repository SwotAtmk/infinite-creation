---
name: story-pipeline-cn
description: 中文小说/剧本创作流水线：小说转剧本（素材挖点→三幕结构→场景剧本成稿）、剧本转分镜（分镜表+角色人设卡+AI绘图/视频Prompt）、小说直转分镜（一键拆解角色/场景/镜头，输出下游生成工具兼容 JSON），组成「小说→剧本→分镜」完整链路。当用户需要把小说改成剧本、写出分镜脚本、拆解小说镜头、生成角色人设卡与 AI 绘图提示词时使用。
version: "1.0.0"
user-invocable: true
argument-hint: "[可选：小说/剧本文件路径 / 模式 A小说转剧本 B剧本转分镜 C小说转分镜]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# 小说剧本分镜流水线（story-pipeline-cn）

单包模块化技能，覆盖从**小说 → 剧本 → 分镜**的完整创作链。`SKILL.md` 只做薄路由；分步指令在 `references/`，输出模板在 `templates/`，文件批处理脚本在 `scripts/`。执行前须先 `Read` 对应模式文件。

## 入口：模式选择菜单（首次激活必显）

**规则**：技能被激活时，若用户**未明确指定模式**（即未提供以下任一类明确意图：小说/剧本文件路径、或明确说「转剧本/出分镜/拆镜头」等），**必须先向用户完整展示下方菜单并请其选择，禁止自行假定模式**。即便已提供材料但意图不清，也先展示菜单确认，再进入对应模式。

**展示方式**：优先用交互选择控件列出 3 项（A–C）；若该环境不支持控件，则以纯文本列出并请用户回复字母（A–C）或编号。菜单文本如下，可直接呈现给用户：

```
请选择要运行的模式（A–C）：
A · 小说转剧本  — 选定素材→三幕结构→场景剧本成稿（.md），适合「有小说想改编」
B · 剧本转分镜  — 现成剧本→分镜表+角色人设卡+AI绘图/视频Prompt（.md/.json），适合「已有剧本想可视化」
C · 小说转分镜  — 小说直拆→分镜脚本+角色特征卡+场景特征卡（一键，支持文件批量），适合「快速出分镜/喂给画图模型」
```

选定后，按下方「三模式 + 一条流水线」定位到对应 `references/` 入口执行。

## 三模式 + 一条流水线

| 模式 | 何时用 | 主入口 |
|------|--------|--------|
| **A · 小说转剧本** | 有小说/素材，想改编成可分镜的文学剧本 | `references/novel-to-script.md` |
| **B · 剧本转分镜** | 已有剧本（.md/.txt），想拆分成镜、出人设卡与 AI 提示词 | `references/script-to-storyboard.md` |
| **C · 小说转分镜** | 想跳过中间剧本，直接把小说拆成镜头与角色卡（含批量文件模式） | `references/direct-storyboard.md` |

### 工作链流水线

```
A(小说转剧本) ──→ B(剧本转分镜) ──→ [可选接下游图像/视频生成工具出图出视频]
                       ▲
C(小说转分镜) ＝ A+B 的合并快路径（跳过中间剧本文件，直出分镜 + 下游生成工具兼容 JSON）
```

- 提供**小说/素材**且要改编成剧本 → 模式 A
- 提供**现成剧本**且意图为「出分镜/拆镜头」→ 模式 B
- 提供**小说**且意图为「直接拆镜头/出角色卡/喂画图模型」→ 模式 C（快路径）
- 任一模式产出的 `storyboard.json` 均可直接喂给下游图像/视频生成工具（见 `references/workflow-chain.md` 的桥接说明）

## 目录约定（薄路由）

```
SKILL.md                       # 主控制·薄路由（本文档）
requirements.txt               # 合并依赖（核心纯标准库）
references/                    # 各模式分步指令与规范
  workflow-chain.md            # 完整链路总览、三模式衔接、与下游生成工具桥接
  novel-to-script.md           # 模式 A：小说转剧本
  script-to-storyboard.md      # 模式 B：剧本转分镜
  direct-storyboard.md         # 模式 C：小说转分镜（直拆 + 文件批量）
  style-guide.md               # 共享语法：场景头/景别/运镜/氛围色调/提示词规范
  output-schemas.md            # 各模式输出 JSON/文档格式规范
  fault-handling.md            # 故障处理与容错
templates/
  script-template.md           # 文学剧本模板（三幕式 + 场景格式）
  storyboard-template.md       # 分镜表模板
  character-card-template.md   # 角色人设卡模板（含 AI 绘图提示词）
scripts/
  extract_storyboard.py        # 文件模式：小说→分镜 JSON/MD（改进版，下游生成工具兼容）
```

## 环境与约定

- **路径**：所有路径使用绝对路径，`/` 作分隔符。`<skill_root>` 指本技能根目录。
- **输出落盘**：所有产物写入用户指定的项目目录（默认 `<skill_root>/outputs/<作品名>/`）；先建目录再写文件，中间文件一律保留不删。
- **中文优先**：场景头、对白、提示词草稿默认中文；面向画图/视频模型的 `image_prompt` / `video_prompt` 须在阶段末翻译为英文（见 `style-guide.md` 与 `output-schemas.md`）。
- **人设一致性**：全链路角色名须唯一且稳定；模式 C 的脚本会自动建立 `姓名 → CHAR_xxx` 映射，供下游生成工具直接消费。
- **门控**：模式 A/B 在成稿关键节点建议展示片段请用户确认；模式 C 为批量处理，默认一次出全稿，但长文本建议在 `scripts/extract_storyboard.py` 中分段。
- **下游桥接**：本技能只负责「文本→结构化分镜」，不调用任何画图/视频 API；出图出视频请用下游图像/视频生成服务。桥接字段对齐见 `references/workflow-chain.md`。

## 触发条件

- **小说转剧本**：把小说改成剧本、小说转剧本、改编剧本、文学剧本、小说改编；`/小说转剧本`
- **剧本转分镜**：剧本分镜、出分镜、分镜表、镜头脚本、剧本拆镜；`/剧本转分镜`
- **小说转分镜**：小说分镜、小说转分镜、拆镜头、角色卡、场景卡、AI 绘图提示词；`/小说转分镜`

## 模式映射速查

| 步骤 | 文件 | 用途 |
|------|------|------|
| 链路总览 | `references/workflow-chain.md` | 三模式衔接、与下游生成工具桥接字段 |
| A 小说转剧本 | `references/novel-to-script.md` + `templates/script-template.md` | 挖点/三幕/成稿 |
| B 剧本转分镜 | `references/script-to-storyboard.md` + `templates/storyboard-template.md` + `templates/character-card-template.md` | 分镜表/人设卡/提示词 |
| C 小说转分镜 | `references/direct-storyboard.md` + `scripts/extract_storyboard.py` | 直拆 + 文件批量 |
| 共享语法 | `references/style-guide.md` | 场景头/景别/运镜/色调/提示词 |
| 输出规范 | `references/output-schemas.md` | JSON/MD 格式 |
| 故障 | `references/fault-handling.md` | 容错与重试 |

## Agent 自用工作流检查清单

```
□ 激活时若未指定模式：已先展示 3 模式菜单并请用户选择（未自行假定）
□ 已区分模式 A/B/C，未混跑
□ A：已做素材挖点（前提/角色/冲突/主题）；已用三幕结构；已按 script-template 成稿
□ B：已解析场景与角色；分镜表含景别/运镜/时长；已出人设卡与 image/video prompt 分工
□ C：粘贴路径已按模板直出；文件模式已跑 extract_storyboard.py 并产出 storyboard.json
□ 角色名全链路唯一稳定；C 已建立 CHAR_xxx 映射
□ image_prompt/video_prompt 已（或已标注需）翻译为英文
□ 产物已写入项目目录，中间文件保留未删
□ 如需出图出视频：已提示用户 storyboard.json 可直接喂下游生成工具
```
