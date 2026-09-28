# 出图平台格式：SDXL / ComfyUI

## Prompt 结构（正向）
```
(最重要的元素:1.4), (重要元素:1.2), 普通描述, 风格标签, 质量标签
```

## 权重语法
- `(keyword:1.4)` → 强调，权重1.4
- `(keyword:0.8)` → 弱化，权重0.8
- `[keyword]` → 可选出现

## 推荐正向标签（日漫）
```
(anime style:1.3), (manga illustration:1.2), cel shading, (highly detailed:1.2), masterpiece, best quality, 8k
```

## 推荐负向标签（通用）
```
lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, 3D render, realistic photo, CGI
```

## 示例（正向）
```
(close-up shot:1.3), (teenage boy:1.2), short messy dark hair, sharp eyes, (basketball uniform:1.1), white wristband on left wrist, sitting on bench, calm serious expression, indoor gym warm lighting, (anime style:1.3), (cel shading:1.2), masterpiece, best quality, highly detailed
```

## 注意事项
- 不支持中文
- 括号权重语法是 SDXL/A1111 专用，Midjourney 不支持
- 正负向分开输入两个文本框
- 人物一致性推荐配合 ControlNet + 参考图使用
