# 工作链总览与衔接规则（workflow-chain）

本技能把「小说 → 剧本 → 分镜」拆成三个可独立调用、也可串联的模式。本文档定义它们的衔接契约与下游（图像/视频生成工具）桥接方式。

## 一、三种入口的产物契约

| 模式 | 输入 | 直接产物 | 可下游衔接 |
|------|------|----------|------------|
| A 小说转剧本 | 小说/素材（粘贴或文件） | `script.md`（文学剧本） | → B（把 script.md 喂给模式 B） |
| B 剧本转分镜 | `script.md` 或现成剧本 | `storyboard.md` + `storyboard.json` + 角色卡 | → 下游图像/视频生成工具（出图出视频） |
| C 小说转分镜 | 小说（粘贴或文件） | `storyboard.md` + `storyboard.json` + 角色/场景卡 | → 下游图像/视频生成工具（出图出视频） |

> 模式 C 在内部等价于「A 的剧本结构 + B 的分镜拆解」一次性完成，只是不落中间剧本文件，直接产出分镜。

## 二、同源一致性规则（重要）

当 A→B 串联或 C 直出时，必须遵守：

1. **角色唯一且稳定**：同一角色全链路只用同一个名字；模式 C 的脚本会自动生成 `CHAR_xxx` 编号并建立 `姓名→CHAR_xxx` 映射，B/C 产出的 `storyboard.json` 中 `characters` 字段统一用 `CHAR_xxx`。
2. **场景编号连续**：场景从 `S01` 起顺序编号；镜头编号 `S01_01, S01_02 … S02_01`，与下游生成工具的 `shot_id` 完全一致。
3. **画风前缀统一**：整部作品的 `art_style_prefix`（如 `anime style, cel shading, vibrant colors`）在分镜阶段只填一次，所有镜头共用。
4. **提示词分工**：`image_prompt` 只描述静态画面（景别+角色+场景+光线），`video_prompt` 只描述运动（镜头运动+角色动作）；视频模型以首帧图决定人物外貌，故 `video_prompt` 不得重复外貌描写。

## 三、与下游图像/视频生成工具的桥接（出图出视频）

本技能**不调用任何画图/视频 API**，只产出结构化分镜。要真正出图出视频，交给下游图像/视频生成工具（支持 `image_prompt` / `video_prompt` 的文生图、图生视频模型）。桥接方式：

### 字段对齐表

| story-pipeline-cn 产出 | 下游生成工具期望 | 说明 |
|------------------------|----------------|------|
| `storyboard.json` 整体 | `storyboard.json` | 文件名/结构可直接复用 |
| `title` | `title` | 剧名/作品名 |
| `art_style_prefix` | `art_style_prefix` | 画风标签，须已填 |
| `shots[].shot_id`（如 `S01_01`） | `shots[].shot_id` | 完全一致 |
| ` (shots[].duration` | `shots[].duration` | 秒；建议 2–6s |
| `shots[].description_cn` | （无对应，仅人读） | 下游生成工具用 `image_prompt` 出图 |
| `shots[].image_prompt`（**英文**） | `image_prompt` | 须英文，否则画图模型效果差 |
| `shots[].video_prompt`（**英文**） | `video_prompt` | 须英文，仅运动 |
| `shots[].characters`（`CHAR_xxx`） | `characters` | 完全一致 |
| `shots[].dialogue` | `dialogue` | 台词/音效 |
| `shots[].reference_image` | `reference_image` | 初始为 `null`，出图后回填 |

### 操作顺序（接下游生成工具）

```
1. 本技能产出 storyboard.json（已含 CHAR_xxx / shot_id / duration / 英文 image+video prompt）
2. 在下游生成工具的角色目录下按 CHAR_xxx 产出人设卡与参考图
3. 把角色英文 Prompt 填入下游生成工具的角色提示词配置
4. 生成角色人设图 → 分镜图（回填 reference_image）→ 视频片段
```

> 若 `image_prompt` / `video_prompt` 仍是中文草稿，先在 B/C 阶段末翻译为英文，或在出图阶段前用 LLM 批量翻译，否则出图质量会明显下降。

## 四、典型组合示例

- **想认真改编一部小说**：A（先出剧本，反复打磨）→ B（再拆分镜）。
- **急着要分镜喂画图模型**：C（直出，文件批量，一次拿 JSON）。
- **已有剧本想可视化**：直接 B。
- **全自动化小说→短片**：C（`--format both`）→ 翻译英文 prompt → 下游生成工具出片。
