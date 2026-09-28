# 共享语法与规范（style-guide）

三模式共用的「剧本/分镜语言」。写剧本、拆分镜、出提示词前先读本节，保证下游（含图像/视频生成工具）能直接消费。

## 一、场景头规范（scene header）

统一格式，便于程序解析与人工阅读：

```
【场景 01】室外·废弃工厂·傍晚
```

| 段 | 写法 | 示例 |
|----|------|------|
| 场景标 | `【场景 NN】` | `【场景 01】` |
| 地点·子地点 | `室内/室外·具体地点` | `室外·废弃工厂` |
| 时间（可选） | `清晨/白天/黄昏/夜晚` | `傍晚` |

也兼容剧本常见写法：`INT.` / `EXT.`、 `第X场`、`场景X`。解析优先级：场景标头 → 双空行切分。

## 二、景别速查（shot size）

| 代码 | 中文 | 取景范围 | 用途 |
|------|------|----------|------|
| `ECU` | 大特写 | 眼睛/嘴唇/手部细节 | 极致情绪、关键道具 |
| `CU` | 特写 | 头至肩 | 情绪、对白 |
| `MCU` | 中近景 | 头至胸 | 对话、反应 |
| `MS` | 中景 | 头至腰 | 动作与对话并重 |
| `MLS` | 中远景 | 全身+少量环境 | 动作全貌 |
| `LS` | 全景 | 全身+环境 | 建立人物关系 |
| `ELS` | 大全景 | 广阔场景、人渺小 | 建立场景、史诗感 |
| `OTS` | 过肩 | 一肩后看另一人 | 对话张力 |
| `POV` | 主观 | 角色所见 | 代入感 |

> 中文稿可写「全景/中景/近景/特写/大特写」，输出 JSON 时映射到上表代码。

## 三、运镜速查（camera movement）

| 代码 | 中文 | Prompt 关键词 |
|------|------|--------------|
| `STATIC` | 固定 | `static shot, fixed camera` |
| `PUSH IN` | 推镜 | `slow push in, camera moves forward` |
| `PULL OUT` | 拉镜 | `pull back shot, camera pulls away` |
| `PAN L/R` | 横摇 | `pan left/right, horizontal sweep` |
| `TILT U/D` | 竖摇 | `tilt up/down` |
| `TRACKING` | 跟镜 | `tracking shot, following character` |
| `HANDHELD` | 手持 | `handheld, shaky cam, documentary` |
| `CRANE UP` | 吊臂升 | `crane up, ascending aerial` |
| `ORBIT` | 环绕 | `orbit shot, 360 rotation` |

## 四、氛围 → 色调 / 光线 / 音效 映射（供分镜自动推断）

| 氛围 | 色调方案 | 光线 | 音效 |
|------|----------|------|------|
| 紧张 | 高对比冷蓝绿 | 低光·冷调 | 低频警报·急促心跳 |
| 温馨 | 暖黄橙低饱和 | 暖橙逆光/自然光 | 轻柔钢琴·背景人声 |
| 压抑 | 去饱和冷灰 | 低光·冷调 | 沉默·低沉弦乐 |
| 激烈 | 高饱和红橙 | 强光/混乱 | 打击乐·音效爆破 |
| 神秘 | 深蓝紫暗调 | 低光·冷调 | 环境音·诡异回响 |
| 平静 | 中性自然色 | 自然光·散射 | 自然环境音 |

## 五、分镜 Prompt 七段结构（面向画图/视频模型）

优先级从高到低：

```
[1.画风标签] + [2.场景/环境] + [3.主体/角色] + [4.动作/状态] +
[5.镜头语言] + [6.光线/氛围] + [7.质量标签]
```

- **画风标签**：来自 `art_style_prefix`，所有镜头共用。
- **image_prompt**：含 1–6（静态画面），不含运动。
- **video_prompt**：只含 5（镜头运动）+ 4（角色动作），**不重复外貌**。
- **强制**：image_prompt / video_prompt **画面中不得出现任何文字、字幕、水印、logo、标语、签名**；对白只通过声音表达，绝不写成画面上的字幕。

### 完整示例（英文）

```
anime style, 2D animation, cel shading, vibrant colors —
dark abandoned factory interior, evening light through broken windows, dusty atmosphere —
young male character with black hair wearing dark hoodie, holding flashlight, full body —
slowly walking forward scanning walls, cautious expression —
tracking shot following character —
dramatic chiaroscuro lighting —
high quality, smooth animation, fluid motion, 1280x720
```

## 六、台词与情绪标注

```
林晨（从铁门缝隙侧身而入，神色警惕）："来了三次了……每次都差一点。"
[画面：手电光扫过墙壁，定格在奇异符文上。]
[音效：风声，远处城市嘈杂声淡出]
[情绪：震惊→恐惧→决意]
```

- 括号内为**表演/动作指示**，不入画面描述。
- `[画面：…]` / `[音效：…]` / `[BGM：…]` / `[情绪：A→B→C]` 为结构化标注，便于后续分镜与表情动画设计。

## 七、镜头时长参考（长镜头模式）

一个主镜头 = 一个连续剧情段（同一场景的连续动作 + 多句连贯对白），时长 **5–15s（最长 15s）**；镜头内部用「子分镜（sub_shots）」按时间轴承载多个节拍。

| 子分镜节拍类型 | 节拍时长 |
|----------|----------|
| 动作战斗 | 0.5–2s |
| 对白/交流 | 2–5s（多句连续对白合并，不逐句拆镜） |
| 情绪特写 | 2–4s |
| 环境建立 | 3–8s |
| 过渡/间奏 | 1–3s |

> 子分镜时间首尾相接、时长之和 = 主镜头 duration（≤15s）。单次生成最长 15s，超出则换下一个主镜头。**禁止一句台词一镜 / 每段落一镜的碎片化拆分。**
