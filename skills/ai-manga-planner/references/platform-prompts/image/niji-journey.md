# 出图平台格式：Niji Journey

## 概述
Niji Journey 是 Midjourney 的日漫专用版本，风格更贴近日本动漫，适合本项目。

## Prompt 结构
```
[主体描述], [场景/环境], [光线/色调], [构图/镜头], [风格细化], [参数]
```

## 推荐风格标签
```
anime style, manga panel, expressive eyes, dynamic pose, cel shading
```

## 场景风格标签
- 热血场景：`shounen manga style, action lines, speed lines, dynamic`
- 情感场景：`shoujo manga style, soft lighting, emotional expression`
- 闪回场景：`desaturated, cold tone, memory style, faded colors`

## 必加参数
```
--niji 6 --ar 16:9
```

## 示例
```
close-up, teenage boy with short messy dark hair, basketball uniform #11, white wristband on left wrist, sitting on bench, calm serious eyes, indoor gym, warm overhead lighting, shounen manga style, expressive eyes, cel shading --niji 6 --ar 16:9
```

## 注意事项
- 不支持中文
- 角色外貌描述要精准，保证跨镜头一致性
- 动作场景加 `speed lines` 或 `motion blur`
- 情绪特写加 `expressive eyes` 效果更好
