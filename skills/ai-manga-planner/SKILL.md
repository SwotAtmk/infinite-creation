---
name: ai-manga-planner
description: AI漫剧前期策划助手，提供完整的9阶段漫剧策划工作流。当用户说"帮我策划漫剧"、"我想做AI漫剧"、"启动漫剧策划"、"漫剧策划工作流"，或提到"AI漫剧"+"策划/剧本/大纲"时激活。支持从需求收集、市场分析、世界观构建、人物设计、故事结构、剧本创作，到分镜脚本（含出图Prompt）、AI视频提示词（含镜头运动）、剪辑配乐设计的全流程输出，并适配即梦、可灵、Vidu、Runway、Midjourney等主流AI生成平台。
---

# SKILL: AI漫剧前期策划助手

## 触发条件
当用户说以下任意内容时激活本 Skill：
- "帮我策划一部漫剧"
- "我想做AI漫剧"
- "漫剧前期策划"
- "启动漫剧策划"
- "漫剧策划工作流"
- 提到"AI漫剧"+"策划"/"剧本"/"大纲"

## 概述
本 Skill 提供一套完整的 AI 漫剧前期策划工作流，包含 9 个阶段，通过多 Agent 协作完成从需求收集到可执行制作包的全部策划工作。每个关键节点设有人工确认卡点，确保方向不跑偏。

## 工作流阶段

```
STATE 0  → 需求收集
STATE 1  → 市场分析
STATE 2  → 世界观构建
STATE 3  → 人物设计
STATE 4  → 故事结构（分集大纲）
STATE 5  → 剧本创作
           ↓ [询问出图平台]
STATE 6  → 分镜脚本（按选定平台格式输出Prompt）
           ↓ [询问视频生成平台]
STATE 6B → AI视频生成提示词（含镜头运动）
STATE 7A → 剪辑设计（配乐+节奏）
STATE 7  → 交付打包
```

## 执行规则

### 启动
1. 读取本文件及 `references/workflow.md`
2. 检查 workspace 下是否有未完成项目（`projects/*/state.json`）
   - 有 → 询问用户是否继续还是新建
   - 无 → 直接进入 STATE 0

### 每个 State 的执行模式
1. 读取对应 `references/prompts/` 下的 Agent 提示词
2. 注入已确认的上游文档作为上下文
3. 生成输出并展示给用户
4. **等待用户确认**（✅ 继续 / ✏️ + 修改意见 重新生成）
5. 用户确认后，将输出写入项目文件，更新 `state.json`，进入下一 State

### 修改次数限制
- 每个 State 最多自动重新生成 3 次
- 超过 3 次提示：「建议您直接编辑文件后告诉我继续」

### 平台询问节点（重要）
工作流中有两个平台询问节点，必须在对应 State 开始前完成：

**节点1：STATE 5 完成后，进入 STATE 6 之前**
询问：「请问您准备使用哪个平台生成分镜图片？」
选项：
- Midjourney（默认）
- Niji Journey（日漫专用）
- SDXL / ComfyUI
- 即梦 / 豆包
- 其他（用户自填）

→ 记录到 state.json 的 `image_platform` 字段
→ STATE 6 按该平台的 Prompt 格式输出（详见 `references/platform-prompts/image/`）

**节点2：STATE 6 完成后，进入 STATE 6B 之前**
询问：「请问您准备使用哪个平台生成视频？」
选项：
- 即梦（默认）
- 可灵
- Vidu
- Runway
- 其他（用户自填）

→ 记录到 state.json 的 `video_platform` 字段
→ STATE 6B 按该平台的 Prompt 格式输出（详见 `references/platform-prompts/video/`）

### 文件存储路径
所有项目文件保存在：
```
workspace/projects/{项目名}/
```
详见 `references/workflow.md`

### 上下文注入规则
每个 Agent 调用时，自动将以下已确认文档注入上下文：
- STATE 2+ → 注入 `brief.md`
- STATE 3+ → 注入 `market-report.md` + `world-bible.md`
- STATE 4+ → 注入 `characters.md`
- STATE 5+ → 注入 `outline.md`
- STATE 6+ → 注入对应集数的 `scripts/epXX.md`
- STATE 6B+ → 注入对应集数的 `storyboards/epXX-board.md`

## 提示词文件位置
- 市场分析：`references/prompts/market-analyst.md`
- 世界观构建：`references/prompts/story-architect.md`
- 人物设计：`references/prompts/character-designer.md`
- 编剧：`references/prompts/screenwriter.md`
- 分镜编辑：`references/prompts/storyboard-writer.md`
- 视频提示词生成：`references/prompts/video-prompt-writer.md`
- 剪辑设计：`references/prompts/editor-designer.md`

## 模板文件位置
- 世界观圣经：`references/templates/world-bible.md`
- 人物设定表：`references/templates/character-sheet.md`
- 分集大纲：`references/templates/episode-outline.md`
- 剧本：`references/templates/script.md`
- 分镜脚本：`references/templates/storyboard.md`
- 视频提示词：`references/templates/video-prompts.md`
- 剪辑设计：`references/templates/edit-design.md`

## 平台格式参考文件位置
- 出图平台格式：`references/platform-prompts/image/`
  - `midjourney.md`
  - `niji-journey.md`
  - `sdxl-comfyui.md`
  - `jimeng-doubao.md`
- 视频平台格式：`references/platform-prompts/video/`
  - `jimeng.md`（即梦，默认）
  - `kling.md`（可灵）
  - `vidu.md`
  - `runway.md`
