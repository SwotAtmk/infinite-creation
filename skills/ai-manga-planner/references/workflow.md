# 工作流状态机定义

## 项目文件结构

```
workspace/projects/{项目名}/
├── state.json              # 当前进度状态
├── brief.md                # 需求简报
├── market-report.md        # 市场分析报告
├── world-bible.md          # 世界观圣经
├── characters.md           # 人物设定表
├── outline.md              # 分集大纲
├── scripts/
│   ├── ep01.md
│   └── ...
├── storyboards/
│   ├── ep01-board.md       # 分镜脚本（含出图Prompt）
│   └── ...
├── video-prompts/
│   ├── ep01-video.md       # 视频生成提示词
│   └── ...
├── edit-design/
│   ├── ep01-edit.md        # 剪辑设计（配乐+节奏）
│   └── ...
└── README.md               # 交付打包总览
```

## state.json 格式

```json
{
  "project": "项目名称",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "current_state": 0,
  "completed_states": [],
  "total_episodes": 0,
  "current_episode": 0,
  "retry_count": 0,
  "image_platform": "",
  "video_platform": "",
  "files": {
    "brief": "brief.md",
    "market_report": "market-report.md",
    "world_bible": "world-bible.md",
    "characters": "characters.md",
    "outline": "outline.md",
    "scripts": [],
    "storyboards": [],
    "video_prompts": [],
    "edit_designs": []
  }
}
```

## 状态机定义

### STATE 0: 需求收集
- **触发**：用户启动策划工作流
- **操作**：
  1. 向用户提问（见下方问题清单）
  2. 整理用户回答，生成 brief.md
  3. 初始化 state.json
- **输出文件**：`brief.md`
- **人工卡点**：✅ 确认需求简报后进入 STATE 1

**提问清单：**
1. 题材/类型？（甜宠/悬疑/奇幻/都市/历史…）
2. 目标平台？（抖音/B站/小红书/多平台）
3. 预计集数和每集时长？
4. 画风偏好？（日漫/国风/美漫/写实…）
5. 有无参考作品？（漫剧/漫画/影视剧均可）
6. 有无特殊要求或禁忌？

---

### STATE 1: 市场分析
- **触发**：STATE 0 完成
- **Agent**：Market Analyst
- **注入上下文**：`brief.md`
- **输出文件**：`market-report.md`
- **人工卡点**：确认创意方向（3选1）后进入 STATE 2

---

### STATE 2: 世界观构建
- **触发**：STATE 1 完成，用户选定方向
- **Agent**：Story Architect
- **注入上下文**：`brief.md` + `market-report.md`
- **输出文件**：`world-bible.md`
- **模板**：`references/templates/world-bible.md`
- **人工卡点**：✅ 确认世界观圣经后进入 STATE 3
- **⚠️ 重要**：世界观一旦锁定，后续修改成本极高

---

### STATE 3: 人物设计
- **触发**：STATE 2 完成
- **Agent**：Character Designer
- **注入上下文**：`brief.md` + `world-bible.md`
- **输出文件**：`characters.md`
- **模板**：`references/templates/character-sheet.md`
- **人工卡点**：✅ 确认人物设定后进入 STATE 4
- **⚠️ 重要**：人物设定锁定后同步更新世界观中的人物章节

---

### STATE 4: 故事结构（分集大纲）
- **触发**：STATE 3 完成
- **Agent**：Story Architect（复用）
- **注入上下文**：`brief.md` + `world-bible.md` + `characters.md`
- **输出文件**：`outline.md`
- **模板**：`references/templates/episode-outline.md`
- **人工卡点**：✅ 确认分集大纲后进入 STATE 5

---

### STATE 5: 剧本创作（循环）
- **触发**：STATE 4 完成
- **Agent**：Screenwriter
- **注入上下文**：`world-bible.md` + `characters.md` + `outline.md` + 当前集大纲
- **输出文件**：`scripts/ep{XX}.md`
- **模板**：`references/templates/script.md`
- **人工卡点**：每集确认后写入下一集，直到所有集数完成
- **循环条件**：current_episode < total_episodes
- **完成后**：询问出图平台，记录到 state.json `image_platform` 字段，进入 STATE 6

**出图平台选项：**
| 选项 | 平台 | 格式参考 |
|------|------|---------|
| 1（默认） | Midjourney | `references/platform-prompts/image/midjourney.md` |
| 2 | Niji Journey | `references/platform-prompts/image/niji-journey.md` |
| 3 | SDXL / ComfyUI | `references/platform-prompts/image/sdxl-comfyui.md` |
| 4 | 即梦 / 豆包 | `references/platform-prompts/image/jimeng-doubao.md` |
| 5 | 其他 | 用户自描述，按通用格式输出 |

---

### STATE 6: 分镜脚本（循环）
- **触发**：STATE 5 某集完成，已确认出图平台
- **Agent**：Storyboard Writer
- **注入上下文**：`world-bible.md` + `characters.md` + `scripts/ep{XX}.md`
- **输出文件**：`storyboards/ep{XX}-board.md`
- **模板**：`references/templates/storyboard.md`
- **⚠️ 重要**：所有 Prompt 必须按 `image_platform` 指定的格式输出
- **人工卡点**：每集分镜确认后继续下一集
- **完成后**：询问视频生成平台，记录到 state.json `video_platform` 字段，进入 STATE 6B

**视频平台选项：**
| 选项 | 平台 | 格式参考 |
|------|------|---------|
| 1（默认） | 即梦 | `references/platform-prompts/video/jimeng.md` |
| 2 | 可灵 | `references/platform-prompts/video/kling.md` |
| 3 | Vidu | `references/platform-prompts/video/vidu.md` |
| 4 | Runway | `references/platform-prompts/video/runway.md` |
| 5 | 其他 | 用户自描述，按通用格式输出 |

---

### STATE 6B: AI视频生成提示词（循环）
- **触发**：STATE 6 某集完成，已确认视频平台
- **Agent**：Video Prompt Writer
- **注入上下文**：`characters.md` + `storyboards/ep{XX}-board.md` + 视频平台格式文件
- **输出文件**：`video-prompts/ep{XX}-video.md`
- **模板**：`references/templates/video-prompts.md`
- **核心任务**：
  1. 基于分镜脚本，逐镜生成视频提示词
  2. 每个镜头加入镜头运动描述（推/拉/摇/移/跟/升/降/静止）
  3. 描述运动幅度（缓慢/适中/快速）和方向
  4. 按选定平台语法格式输出
- **人工卡点**：每集确认后继续下一集

---

### STATE 7A: 剪辑设计
- **触发**：STATE 6B 某集完成
- **Agent**：Editor Designer
- **注入上下文**：`outline.md` + `scripts/ep{XX}.md` + `storyboards/ep{XX}-board.md`
- **输出文件**：`edit-design/ep{XX}-edit.md`
- **模板**：`references/templates/edit-design.md`
- **核心输出**：
  1. **配乐建议**：按场景划分，描述情绪、节奏、乐器
  2. **配乐生成提示词**：针对 Suno / Udio 平台的生成提示词
  3. **剪辑节奏建议**：每个场景的镜头时长建议、切点建议、特效建议
- **人工卡点**：每集确认后继续下一集

---

### STATE 7: 交付打包
- **触发**：所有集数的全部阶段均已完成
- **操作**：
  1. 汇总所有文档清单
  2. 生成项目总览 README.md（含制作使用指引）
  3. 更新 state.json 标记 completed
  4. 告知用户完整策划包路径
