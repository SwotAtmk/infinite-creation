# 出图平台格式：Midjourney

## Prompt 结构
```
[主体描述], [场景/环境], [光线/色调], [构图/镜头], [风格标签], [参数]
```

## 风格标签（日漫）
```
anime style, manga illustration, cel shading, vibrant colors
```

## 质量标签
```
masterpiece, best quality, highly detailed, sharp focus
```

## 必加参数
```
--ar 16:9 --style raw --v 6
```
日漫风用 Niji 模式时改为：`--niji 6`

## 负向提示词
Midjourney 不支持负向提示词（--no 参数有限），使用 `--no` 排除关键元素：
```
--no text, watermark, signature, 3D, realistic
```

## 示例
```
close-up shot, male teenager with messy dark hair, basketball uniform, sitting on bench looking forward, calm serious expression, indoor gym warm lighting, anime style, cel shading, masterpiece, best quality --ar 16:9 --niji 6
```

## 注意事项
- 不支持中文，必须用英文
- 单个 Prompt 建议不超过 60 词
- 角色描述词放最前，风格标签放最后
