# 输出格式规范（output-schemas）

定义三模式的产物结构与命名，保证可落盘、可程序化、可直接对接下游图像/视频生成工具。

## 一、通用落盘约定

```
outputs/<作品名>/
├── script.md                 # 模式 A 产物
├── storyboard.md             # 模式 B/C 人读分镜表
├── storyboard.json           # 模式 B/C 机读，下游生成工具兼容
├── characters/               # 角色人设卡（B/C）
│   └── CHAR_001.md
└── scenes/                   # 场景特征卡（C，可选）
    └── SCENE_01.md
```

所有路径用绝对路径、`/` 分隔；先建目录再写文件。

## 二、script.md（模式 A）

按 `templates/script-template.md`：

```
# 《作品名》
**类型：** …  **目标时长：** …  **分级：** …

## 世界观简介
## 角色一览（表）
## 剧本正文（【场景 NN】… 格式）
## 创作备注（主题/情感核心/下集钩子）
```

## 三、storyboard.md（模式 B/C）

分镜表（每场景一段）：

| 镜号 | 时长 | 景别 | 运镜 | 画面内容（中文） | 视频生成Prompt（英文） | 角色动作 | 对白/音效 |
|------|------|------|------|----------------|----------------------|---------|-----------|
| S01_01 | 3s | ELS | STATIC | … | … | … | … |

后接「角色人设卡」与「场景特征卡」章节。

## 四、storyboard.json（模式 B/C，下游生成工具兼容）

```json
{
  "title": "作品名",
  "art_style_prefix": "anime style, cel shading, vibrant colors, high quality",
  "character_index": { "林晨": "CHAR_001", "阿九": "CHAR_002" },
  "summary": { "total_shots": 12, "total_scenes": 3, "total_characters": 2 },
  "shots": [
    {
      "shot_id": "S01_01",
      "scene_id": "S01",
      "duration": 4,
      "shot_type": "ELS",
      "description_cn": "废弃工厂外景，夕阳西下，铁架剪影",
      "image_prompt": "abandoned factory exterior, sunset, rusty framework silhouette, golden hour, cinematic, static shot",
      "video_prompt": "slow push in, camera moves forward",
      "characters": ["CHAR_001"],
      "dialogue": "[音效：风声]",
      "mood": "神秘",
      "color_tone": "深蓝紫暗调",
      "light": "暖橙逆光",
      "sound": "环境音·诡异回响",
      "camera_move": "STATIC",
      "reference_image": null
    }
  ],
  "character_cards": [
    {
      "char_id": "CHAR_001",
      "name": "林晨",
      "age": "19",
      "identity": "异能事件独立调查员",
      "appearance": "…",
      "personality": "孤僻/固执/外冷内热",
      "image_prompt_en": "Lin Chen, 19-year-old male, … anime style, full body front view, white background",
      "sample_lines": ["……知道了。"]
    }
  ],
  "scene_cards": [
    {
      "scene_id": "S01",
      "header": "【场景 01】室外·废弃工厂·傍晚",
      "location_type": "室外",
      "time_of_day": "傍晚",
      "mood": "神秘",
      "color_tone": "深蓝紫暗调",
      "light": "暖橙逆光",
      "characters_present": ["CHAR_001"],
      "ai_scene_prompt": "…"
    }
  ]
}
```

> `image_prompt` / `video_prompt` / `image_prompt_en` **必须为英文**，否则画图/视频模型效果差；若上游只产出中文草稿，阶段末须翻译。

## 五、角色人设卡（characters/CHAR_xxx.md）

按 `templates/character-card-template.md`：基础信息 + 外貌 + 服装 + 性格 + **可直接使用的英文图像 Prompt** + 表情/动作变体。

## 六、场景特征卡（scenes/SCENE_xx.md，模式 C 可选）

地点类型 / 时间 / 氛围 / 色调 / 光线 / 出场角色 / AI 场景提示词。
