---
name: image-prompt-writing
description: 为 Krea2 超写实文生图（t2i）与 Qwen-Image-Edit-2511 图生图（i2i）编写中英文提示词。使用时机：为漫剧项目生成人物三视图、场景环境图、道具白底图等资产生图，或基于参考图做一致性变体。输出 prompt 与 negative_prompt。
---

# 图像提示词编写（Krea2 t2i / Qwen i2i）

为资产生图工作流编写提示词。本工程文生图走 Krea2 超写实工作流（节点 CLIPTextEncode），图生图走 Qwen-Image-Edit-2511（参考图 + 指令）。

## 按资产类型选尺寸与构图

- **人物 character → 16:9**：角色设定图，脸部特写（五官/发型/神态/气质）+ 全身正面、侧面、背面三视图，同一人物外貌/服装/配色完全一致，简洁浅色背景，横向布局。
- **场景 scene → 16:9**：环境氛围、空间透视、光线与风格，画面完整可作背景。
- **道具 prop → 1:1**：纯白背景，画面只出现该道具本身，突出形状/材质/细节。

## prompt 编写规则

1. 结构化优于叙事化：按「主体 → 环境/背景 → 光照/材质/色调/视角」分类描述，1~3 句，80~150 字。
2. 先主体核心特征，再环境，最后细节（材质、光影、色调、镜头视角）。
3. 明确镜头视角（特写/中景/全景、正面/侧面/背面、平视/俯视/仰视）。
4. 风格与本项目 style.md 保持一致。
5. **画面内不得出现任何文字、字幕、水印、logo、标语、签名**。

## negative_prompt 规则

通用排除：`blurry, low quality, pixelated, distorted, watermark, text, subtitles, caption, letters, words, text overlay, signature, logo, oversaturated, artificial, plastic-looking`。
人物类额外排除：`extra fingers, deformed hands, mutated hands, fused fingers, plastic skin, over-smoothed`。

## 输出

每个资产输出 JSON：`{"prompt":"...","negative_prompt":"..."}`。prompt 用英文（写实模型对英文响应更好），结构清晰、具体可执行。

## 调用方式

写好后用 `update_asset(id, {prompt, negative_prompt})` 写入对应资产，再用 `generate_asset_image(asset_id)` 或 `generate_assets_batch` 统一提交（批量时优先，避免反复切换工作流导致模型重载）。图生图变体用 `edit_asset_image(asset_id, prompt, reference_asset_id)`。人物换装用 `change_outfit(character_id, outfit)`（生成服装资产，category=costume）。若模型支持图片输入，写提示词前先用 `view_asset(asset_id)` 查看参考图，基于真实图写提示词。
