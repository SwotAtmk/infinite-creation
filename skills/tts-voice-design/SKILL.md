---
name: tts-voice-design
description: 为 Qwen3-TTS 音色设计工作流编写人物音色参数。使用时机：为漫剧人物设计专属音色（音色样本 voice_ref），需给出代表性台词 text 与音色描述 voice_description。输出 text 与 voice_description。
---

# 人物音色设计（Qwen3-TTS）

为每个出场人物设计一个专属音色样本，供后续视频生成时作为 `voice_ref` 参考。

## 输入

- 人物 bible.md 中的 voice 特征（若有）。
- 人物在本章的对白风格（年龄、性别、性格、情绪基调）。

## 先决条件：asset 的 voice_desc（声音画像）

设计音色前，角色资产应带有 `voice_desc`（声音特征描述，性别+年龄段+音色质感，如 `青年男性，嗓音低沉`）：
- 若创建角色资产时未传 `voice_desc`，先调用 `update_asset(asset_id, { voice_desc })` 补充——这样 `design_voice` 才能拿到角色性别/年龄，生成后音色才与角色一致（男主不会变成女声）。
- `voice_desc` 与 `description` 不同：description 是外貌（给文生图），voice_desc 是声音（给 TTS）。不要混用。

## text（朗读文案 · 简短自我介绍）

写 1 句 **20~30 字左右的简短自我介绍**（约 5 秒，口语化、贴合人物语气），作为人物朗读的音色合成样本。示例：`你好呀，我是沈舒妍，喜欢安静的午后和温暖的光，很高兴认识你。`

**禁止长篇大论**：不要塞大段台词、剧情或描写，20~30 字即可；文案过长会生成过长的音色样本。

## voice_description（音色描述 · 不限制字数）

描述目标音色，**不限制字数**，可详细写，覆盖：性别 + 年龄段 + 音色质感（明亮/低沉/沙哑/清亮/温润）+ 语速 + 语气情绪 + 口音/风格。示例：`青年男性，嗓音低沉温和，语速偏慢，带一点书卷气的平静口吻`。

## 输出与调用

对每个人物输出 `{"text":"...","voice_description":"..."}`，然后调用 `design_voice(asset_id, text, voice_description)` 生成音色样本（落盘为该项目 voice_ref）。多个角色连续调用 design_voice，避免中途切回生图工作流造成模型重载。

## 约束

- 音色与人物年龄/性别/性格一致；不同角色音色尽量区分。
- voice_description 中文、具体，避免「好听」这类空词。
- **voice_description 必须包含性别与年龄段**（如「青年男性」「老年女性」），缺失时 TTS 会自由发挥成年轻女声。
