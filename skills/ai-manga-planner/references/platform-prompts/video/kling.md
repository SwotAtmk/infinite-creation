# 视频平台格式：可灵（Kling）

## 概述
快手旗下AI视频生成平台，支持中英文，镜头控制能力较强。

## Prompt 结构
```
[场景描述] + [人物动作] + [镜头运动] + [风格/情绪]
```

## 镜头运动词汇表（可灵推荐写法）
| 运动类型 | 中文写法 | 英文写法 |
|---------|---------|---------|
| 推镜 | 镜头推进 | camera push in / dolly in |
| 拉镜 | 镜头拉远 | camera pull back / dolly out |
| 横移 | 镜头左移/右移 | camera pan left / pan right |
| 升镜 | 镜头上升 | camera tilt up / crane up |
| 降镜 | 镜头下降 | camera tilt down / crane down |
| 跟拍 | 跟随镜头 | tracking shot / follow shot |
| 静止 | 固定镜头 | static shot / locked shot |
| 环绕 | 环绕拍摄 | orbit shot / arc shot |
| 升格 | 慢动作 | slow motion |

## 示例（中文）
```
体育馆替补席，17岁少年坐在最末端，左手摩挲手腕护腕，眼神望向场内，镜头从侧面缓慢推进至近景，固定停留，日系动漫风格，情绪压抑，暖黄灯光
```

## 示例（英文）
```
indoor basketball gym, teenage boy sitting at end of bench, touching wristband, looking at court, camera slowly dolly in from side to close-up, static hold, anime style, suppressed emotion, warm lighting
```

## 注意事项
- 可灵对镜头运动响应较好，推荐明确写出镜头运动词
- 支持「参考图」提升角色一致性
- 建议时长控制在3-5秒一个镜头
