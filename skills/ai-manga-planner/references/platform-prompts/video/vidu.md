# 视频平台格式：Vidu

## 概述
生数科技旗下AI视频平台，支持中英文，动态效果流畅。

## Prompt 结构
```
[主体+动作], [场景], [镜头运动], [风格], [时长]
```

## 镜头运动词汇（Vidu推荐）
| 运动类型 | 写法 |
|---------|------|
| 推镜 | zoom in / push forward |
| 拉镜 | zoom out / pull back |
| 横移 | pan left / pan right |
| 跟拍 | follow shot |
| 仰拍 | low angle |
| 俯拍 | high angle / bird's eye |
| 静止 | static / fixed |
| 慢镜 | slow motion / 0.5x speed |

## 示例
```
teenage boy in basketball uniform sitting on bench, touching wristband, looking forward, indoor gym warm light, slow pan from side to front close-up, anime style, 3s
```

## 注意事项
- Vidu 对英文Prompt响应更稳定
- 镜头运动词放在场景描述后
- 支持首帧/尾帧图片参考，有助于角色一致性
