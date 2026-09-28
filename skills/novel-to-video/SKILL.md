---
name: novel-to-video
description: 把小说或故事全自动改编为带语音的短视频/漫剧成片。使用时机：用户提供小说原文或故事想法，要求全自动产出视频、人物形象一致、场景连续、分镜可逐段审查与重生成。覆盖：剧情改编、剧本与分镜、人物/场景/道具资产生成、MiniMax H3 Ref2VA 视频生成、成片拼接。不适用：单张图片、简单修图、无剧情的单个镜头。
---

# Novel-to-Video（小说全自动成片）

把一部小说/故事，全自动产出「带语音的漫剧/短视频成片」。**全程无需人工确认**，可长时运行；完成后产物（分镜 + 成片）供事后审查与重生成。

## 硬性约定

1. 一切操作通过工具完成，**不要向用户询问中间确认**；遇到失败按「重试 → 降级 → 记录并继续」处理。
2. 幂等：资产/分镜生成前先查已存在且成功的结果（有 image_path / video_path 且 status=done 则跳过），保证可断点续跑。
3. 一致性优先：每个人物只产出一张 canonical 参考图，跨所有分镜复用；所有视频提示词统一注入风格 + 角色外观 + 场景描述。
4. 参考标签规范遵循 h3-prompt-writing 技能（__MINIMAX_H3_REF_N__ 占位符 + <Picture N> 标签）。
5. 语音：voice_ref 必须是项目内真实存在的文件；不存在一律不引用（见步骤 3），避免 ComfyUI LoadAudio 报 Invalid audio file 导致整图被拒。**参考音频只提交「有台词」角色**：多人同场（如 5 人）时不要把全部在场角色的音色都塞进参考素材，只给实际开口说话的角色（如只有 2 人对话就只传这 2 人的音色）；单分镜参考音频 ≤3 段。
6. **分镜完整、不省，但按剧情段聚合成长镜头、不拆碎**：同一场景的连续动作与多句连贯对白合并为一个主镜头（时长贴合内容，2–15s，最长 15s），镜头内部用 sub_shots 按时间轴承载多个节拍/多句对白，保证对话连贯流畅；只有场景切换或时空/情绪明显断开才换下一镜。完整覆盖全部场景与关键节拍，剧情、对白、节拍须与原文一致——**禁止一句台词一镜 / 每段落一镜的碎片化拆分**，也禁止为省时省钱的摘要式删减。
7. **画面/视频里不得出现任何文字、字幕、水印、logo、标语、签名**：所有资产生图 prompt、video_prompt、sub_shots 画面描述一律不要要求出现文字；对白只通过声音（voice_ref）表达，绝不写成画面上的字幕。

## 流水线步骤

### 1. 只处理目标章节（targetChapter）
- 本次生成目标由 seed 里的 targetChapter 指定：若为具体章节，**只处理这一章**，其它章节一律不要碰（不要规划/改写/删除其分镜）；若为空则为「全部章节」。
- 用 get_project / list_chapters 读取章节与全局资产；只对目标章读 novel → 产出该章大纲 JSON：title、logline、characters[{name,appearance,voice,outfits:[{name,description}]}]、scenes[{name,description}]、props[{name,description}]、storyboard[]。其中每个角色的 outfits 是该角色的「衣橱」——根据剧情为该角色设计的**多套服装**（每套短名 name + 外观描述 description，如「进城旧衣」「沐浴后家居服」「金缕阁新衣」），而非一套。
- characters/scenes/props 若全局资产库已存在同名资产（get_project.assets 有该 name 且 image_path 存在）→ 直接复用；只新建本章新增/换装/新场景/新道具。
- **换装走服装资产（铁律）**：同一角色在任一「换装事件」后都要换服装——包括不同章节/场景需要不同服装，以及同一场景内沐浴/洗澡/更衣/换衣/换装/换上(新)衣（洗澡后理应换干净衣服）。用 change_outfit(character_id=角色资产id, outfit=服装描述) 生成服装资产（category=costume，parent_id 指向角色），并在「换装事件之后」的镜头用 set_storyboard 的 costumes 字段引用；换装事件之前的镜头继续用角色原图或旧服装，不引用则该镜不受影响。系统会在 set_storyboard 时自动识别换装事件兜底，但你应主动生成并引用。
- 把大纲写入项目 context（bible.md / style.md 骨架）。

### 2. 一致性锚点
- bible.md：每个角色唯一外貌/配色/声音特征（一句话可复用描述）；并写出该角色的「衣橱」——多套服装清单（每套短名 + 外观描述），不要写死为唯一一套；这些服装后续都会生成服装资产供分镜引用。
- style.md：统一画风/光线/色调/镜头语言，后续所有生图与视频提示词强制引用。

### 3. 资产生成（技能驱动：先加载技能写参数，再统一提交）
- **先加载技能**：调用 skill(image-prompt-writing) 与 skill(tts-voice-design)，严格按其规范为每个资产产出参数（不要凭感觉写，也不要让工具用描述兜底）。
- **视觉参考（若系统提示说明当前 LLM 支持图片输入）**：写图片/图生图提示词前，先用 view_asset(asset_id) 查看资产当前参考图，基于真实图写提示词；不支持图片输入则跳过此步。
- **图片提示词**：对每个图片资产（人物/场景/道具），按 image-prompt-writing 写出 prompt 与 negative_prompt，用 update_asset(id, {prompt, negative_prompt}) 写入。
- **音色参数**：对每个角色，按 tts-voice-design 写出 text（**20~30 字左右的简短自我介绍，约 5 秒，禁止长篇大论**）与 voice_description（**音色描述，不限制字数，可详细写**），连续调用 design_voice(asset_id, text, voice_description) 生成音色样本（落盘 voice_ref）。
- **再统一提交图片**：generate_assets_batch 会用已写入的 prompt 连续文生图全部图片资产（人物 16:9 三视图、场景 16:9 环境图、道具 1:1 白底图），已生成成功的自动跳过（幂等），失败的标记并继续。
- **生成衣橱（多套服装）**：人物 canonical 图生成完成后，对每个角色调用 design_outfits(character_id, outfits) 一次性生成该角色衣橱里的全部服装资产（图生图，保持脸/发型/画风一致）；每套服装成为 category=costume、parent_id 指向该角色的资产，素材库会按角色展示这些服装。
- 批量后若仍有失败，针对性重试；音色设计失败可跳过（视频仍可无配音生成），但应优先尝试设计而非直接放弃。

### 4. 分镜脚本（完整覆盖 · 长镜头聚合，不拆碎）—— 先加载 story-pipeline-cn 再拆分
- **先调用 skill(story-pipeline-cn) 加载拆分规约**，严格按其模式C 长镜头版拆分（禁止凭记忆臆造）。
- **视觉参考（若支持图片输入）**：拆分/写 sub_shots 前，用 view_asset 一次性查看每个唯一角色/场景/服装的参考图并记住、跨镜复用（不要逐镜重复查看同一张图）；仅当某镜头引用了尚未看过的资产时才用 view_shot_references(shot_id) 补看，确保画面描述与人物/场景/服装一致。
- **硬性要求：完整覆盖整章，但按「连续剧情段」聚合成长镜头，禁止碎片化**。镜头数 ≈ 场景切换次数（而非每段落一镜）；同一场景内连续动作 + 多句连贯对白合并成一个主镜头。
- 拆分规则（story-pipeline-cn · 模式C · 长镜头版）：
  1. 先按【场景 NN】地点·时间聚合本章（场景头，如「【场景 01】图书室·黄昏」）。
  2. 每个场景内按「连续剧情段」拆镜头：**同一场景的连续动作 + 多句连贯对白 → 1 个主镜头（时长贴合内容，2–15s，最长 15s）**；仅当场景切换、时间跳跃、或动作/情绪明显断开时才换下一镜。**禁止一句台词一镜 / 每段落一镜。**
  3. 每镜字段：景别（ECU/CU/MCU/MS/MLS/LS/ELS/OTS/POV）、运镜（STATIC/PUSH IN/PULL OUT/PAN/TILT/TRACKING/HANDHELD/CRANE UP/ORBIT）、光线、色调、音效、画面内容、对白（原文台词，同一镜可含多句连续对白，多行「人物：台词」）、镜头时长（贴合内容，2–15s，最长 15s）。
  4. sub_shots（子分镜时间轴）：把整个主镜头按时间连续拆成多个子分镜（如 0-3s / 3-6s / 6-10s…，**首尾相接、各子分镜时长之和 = duration**）；每个子分镜写画面内容 + 运镜 + 该段对白，让多句对白在同一镜头内自然连贯、不断档。
  5. **多人对话拆镜**：**同一分镜最多 2 个说话人**；一场戏若必须有 ≥3 人轮流开口对话，拆成多个分镜，使每个分镜 ≤2 个说话人（参考音频只随说话人走，避免单分镜参考音频超限）。
- Prompt 七段式：画风 + 场景 + 主体 + 动作/状态 + 镜头语言 + 光线/氛围 + 质量；video_prompt 只写「镜头运动 + 角色动作」（不重复外貌），image_prompt 静态。中文场景头，**image/video prompt 用英文**，且**画面中不得出现任何文字/字幕/水印/logo**。
- **映射到 set_storyboard（我们系统镜头）**：每个主镜头 = 一条 set_storyboard（chapter=该章 title）——idx=章节内镜头序号；scene_name=场景头；character_ids=该镜角色（角色名→资产id）；scene_ids=该镜场景资产；costumes=该镜各角色此刻所穿的服装（服装短名→服装资产id，从该角色衣橱里按剧情选对应那套）；camera=运镜；dialogue=该镜全部对白（多句合并）；duration=按内容节奏 2–15s（短台词给 2–4s，禁止为凑时长拖长）；sub_shots=上述子分镜时间轴（首尾相接）。**video_prompt 不在这一步写**，留到步骤 5 加载 h3-prompt-writing 后逐镜写入。
- **写入前自检覆盖度**：用 get_project 看本章已有镜头，确认每个【场景】、每段连续对白/关键节拍都被某个主镜头覆盖；漏则补。**不得因「够了/时间久」删减剧情，也不得拆碎成一句一镜。**
- 用 set_storyboard 一次性写入本章全部镜头；续章用更高 idx + chapter 追加，绝不覆写旧章已 done 镜头。

### 5. 先写 H3 视频提示词，再一整章全部生成（r2v，确定性批量）
- **先调用 skill(h3-prompt-writing) 加载提示词规范**，并读其 references/comfyui-node-adapter.md（官方 <Picture N>/<Audio N> → 本节点 __MINIMAX_H3_REF_N__ 的映射与平铺格式）。
- **逐镜写 video_prompt**：对本章每个镜头，按 h3-prompt-writing + 适配说明写出英文平铺提示词（含 __MINIMAX_H3_REF_N__ 参考标签、时间轴画面/运镜/音效、对白走 voice_ref、画面无文字），用 update_shot(shot_id, {video_prompt}) 写入。参考标签序号必须与 assembleShotReferences 的引用顺序一致；**音频参考标签只对应「有台词」角色**（仅说话角色才有 voice_ref，按角色顺序排在图片之后，且 ≤3 段），不要给无台词角色写声音标签。
- 写完全部 video_prompt 后，用 **generate_chapter_videos(chapter=该章)** 一次性生成本章全部镜头视频：工具会循环遍历本章每个镜头（读 shot.video_prompt→generate_shot_video），**不省略任何镜头，一直跑到该章所有镜头 done**。若某镜漏写 video_prompt，工具会用最小兜底提示词（仍可出片，但质量打折），所以务必逐镜写全。
- **硬性要求：不因时间/数量/失败跳过任何镜头**；失败镜头会被标记 failed 并继续。若返回 remaining>0，用 list_shots 看哪些 failed，修复后**再次调用 generate_chapter_videos** 直到 remaining=0。
- 遵守 H3 上限：参考图 ≤9、音视频 ≤3（assembleShotReferences 内部处理）。
- 绝不用"挑几镜先出片"的方式偷工；必须把该章所有镜头视频都生成完，才进入下一步。

### 6. 自审与重试
- 每镜头生成后自审（有无视频、是否报错）；失败自动重试（有上限）。

### 7. 合并导出
- 全部镜头完成后 assemble_video（ffmpeg）合并为成片，写入 exports/。

## 多章节与素材刷新（同项目内继续扩展）

同一项目可含多个章节/幕，按「追加」而非重做，避免旧章节返工：

1. **续跑前先查**：get_project 读已有资产/分镜 + context/continuity 记录。已 done（有 image_path / video_path）的一律跳过，只处理缺失或 pending 的。
2. **append 分镜**：set_storyboard 按 idx upsert（非破坏，已生成镜头保留 video/status）。新章节镜头用更高 idx 并带 chapter（如 "第2章"）归类，不要动旧章节镜头。
3. **按章刷新素材**（灵活编排）：
   - 新场景：为本章新建 scene 资产（create_asset + generate_asset_image），只在本章分镜引用。
   - 人物换装/变体：用 change_outfit(character_id, outfit) 生成服装资产（如「小明-冬装」「小明-沐浴后干净衣裳」），本章分镜用 costumes 字段引用该服装资产；旧章节/旧镜头不引用则不变。同一场景内沐浴/更衣后换装同理，换装事件之后的镜头引用新服装资产。
   - 新道具：为本章新建 prop 资产并生成白底道具图。
   - 新建资产前先查是否已存在（幂等），避免重复。
4. **语音**：仅有真实本地音色文件才登记 voice_ref；新章节如需不同音色（如新增角色声音），另建 voice 资产或换音色文件。
5. 本章镜头全部完成后，在 continuity 记录「第N章完成」，作为断点标记。

## 输出
- data/projects/<id>/assets/（分类）、storyboard/、shots/、exports/、context/。
- 分镜审查 UI 可对任一镜头重新生成。
