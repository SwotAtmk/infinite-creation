---
name: lemo-opuscar
description: 用「代码渲染」方式把用户挑选的风格模板 + 上传的图片/视频/音频素材 + 提示词合成为对应风格的成片视频（脱离 ComfyUI）。当用户要在「无限・秩影」模式下、或指定某个 Lemo-Opuscar 风格（油画厚涂/浮世绘/皮影戏/卫星简报/产品拆解 等 66 种）制作短片时使用。
---

# Lemo-Opuscar · 代码电影库

本技能是「代码渲染」的短片制作库：成片由 `node core/render/*.mjs`（渲染每一帧）+ `sh core/render/mux.sh`（ffmpeg 合成/响度标准化）+ `.venv/bin/python core/tts/*.py`（语音）+ three.js 后处理完成，**不走 ComfyUI**。

## 本目录结构（库根 = `$LIB`）

- `AGENTS.md`：总流程（找风格 → 一问 → Treatment → 制作 → 交付）
- `DIRECTOR.md`：导演规范（故事/声音/节奏/镜头/检查/交付）
- `TECHNIQUE.md`：制作规范（页面/语音/配乐/合成）
- `styles/<slug>/STYLE.md`：每个风格的「不变量」（画面/配色/字体/动效/镜头语法/声音调色板/陷阱）；`styles/<slug>/style.json` 元数据；`styles/<slug>/poster.jpg` 海报
- `styles/README.md`：66 个风格索引（中英文名 + 文件夹）
- `core/README.md`：工具命令速查（render/still/events/readcheck/mux/tts）
- `core/render/video.mjs`、`core/render/still.mjs`、`core/render/events.mjs`、`core/render/readcheck.mjs`、`core/render/mux.sh`、`core/tts/tts.py`、`core/tts/tts_zh.py`

## 在「无限・秩影」模式下如何工作

本模式由系统提示词注入：所选风格 slug、用户提示词、已上传素材清单（图片/视频/音频，其相对路径已给出）。你只拥有 `opuscar_*` 系列工具（外加 `skill`/`skill_reference`/`get_project`/`list_assets`/`view_asset`/`report`），**没有 ComfyUI 领域工具**。

按下面顺序执行：

1. `opuscar_init` 获取 `lib_root`（本库绝对路径）与 `film_dir`（影片工作区绝对路径）。
2. 用 `opuscar_read_file`（cwd=lib）读 `AGENTS.md` 与所选 `styles/<slug>/STYLE.md`，需要细节时再读 `DIRECTOR.md`、`TECHNIQUE.md`、`core/README.md`。

> **依赖安装（首次使用）**：本库渲染需要 node 依赖（`node_modules`）、无头浏览器、python `.venv`（`requirements*.txt`，可选语音/配乐层）。若 `node_modules` 或 `.venv` 缺失，先用 `opuscar_shell(cwd=lib, command='sh plugin/skills/lemo-opuscar/scripts/setup.sh deps')` 装核心依赖（耗时较长；需要语音再加 `deps voice`，需要配乐再加 `deps music`）。
3. 在 `film_dir` 写 `TREATMENT.md`（三个候选结构 + 你的选择，先于 demo）。
4. 写影片页面代码：`index.html` + 依赖的 JS/CSS/资源（遵循 `core/README.md` 的「页面契约」：`window.READY=true`、`window.render(t)` 逐帧确定性绘制、`window.DUR`、可选 `window.EV`、`window.TEXTS(t)`）。**不要在 `styles/` 或 `core/` 里改文件**，只写在 `film_dir`。
5. 渲染：`opuscar_shell(cwd=lib, command='node core/render/video.mjs "<film_dir>" --out "<film_dir>/out/video.mp4"')`；先用 `still.mjs` 抽 1-2 帧自查风格是否符合 `STYLE.md`。
6. 需要语音时用 `opuscar_write_file` 写 `lines.json`，再 `opuscar_shell` 跑 `core/tts/tts.py`/`tts_zh.py` 生成 wav。
7. 合成：`opuscar_shell(cwd=lib, command='sh core/render/mux.sh "<film_dir>/out/video.mp4" "<film_dir>/mix.wav" "<film_dir>/out/final.mp4"')`（无配乐可跳过 mux 直接交付 video.mp4）。
8. `opuscar_save_film` 把成片落为项目视频资产（status=done）。

## 素材语义

- 「剪辑与纪实 / Evidence Films」类风格（字幕新闻、新闻影片、视觉调查、卫星简报、产品拆解、档案灯台等）：把上传的图片/视频/音频当作**真实素材来源**，按 `STYLE.md` 的 `demo/tools/` 说明组织材料。
- 其余风格：上传素材作为**参考/风格锚点**（角色、场景、配色、构图），据此创作。
- 用户提示词是创作主题与方向；系统提示词是硬约束（风格不变量 + 本流程）。

## 铁律

- 只在本库与 `film_dir` 内读写；`opuscar_shell` 的 cwd 只能是 `lib` 或 `film`。
- 幂等、失败先读错误再重试、再降级；不要向用户询问中间确认。
- 交付在 `film_dir`（成片），并 `opuscar_save_film` 落地到项目。
