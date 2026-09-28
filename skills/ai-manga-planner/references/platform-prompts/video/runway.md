# 视频平台格式：Runway

## 概述
Runway Gen-3/Gen-4，专业AI视频平台，纯英文，镜头语言最接近电影术语。

## Prompt 结构
```
[Shot type], [Subject description], [Action/Motion], [Environment], [Lighting], [Style], [Camera movement]
```

## 镜头运动词汇（Runway电影术语）
| 运动类型 | 标准电影术语 |
|---------|------------|
| 推镜 | dolly in / push in |
| 拉镜 | dolly out / pull back |
| 横移 | truck left / truck right |
| 摇镜 | pan left / pan right |
| 竖摇 | tilt up / tilt down |
| 跟拍 | tracking shot |
| 手持感 | handheld, shaky cam |
| 升降 | crane up / crane down |
| 仰角 | low angle shot |
| 俯角 | high angle shot / bird's eye view |
| 静止 | static shot, locked off |
| 慢镜 | slow motion, high frame rate |

## Motion Brush（Runway专有）
Runway Gen-3 支持 Motion Brush，可指定画面区域的运动方向：
- 在Prompt中加：`[Motion: subject moves left, background static]`

## 示例
```
Close-up shot. Teenage boy in basketball uniform #11, short messy dark hair, sitting at end of bench, fingers slowly touching white wristband on left wrist, eyes fixed forward. Indoor basketball gym, warm overhead lighting, slightly dark sideline. Camera slowly dollies in from medium to close-up, holds static. Anime cel-shading style. Melancholic, suppressed emotion. 4 seconds.
```

## 注意事项
- 必须纯英文
- 句子结构比关键词堆砌效果更好（Runway更理解自然语言句子）
- 建议明确写出秒数
- Gen-4 支持角色参考图，强烈建议上传
