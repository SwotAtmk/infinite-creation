import path from 'node:path';
import fs from 'node:fs';
import {
  loadConfig, Projects, Assets, Shots, ShotVideos, Chapters, Workflows, ReferenceImages,
  logger, uid, slugify, randomSeed, chapterStats, Queue,
  ensureProjectDirs, projectDir, resolveProjectPath,
  assembleShotReferences, fallbackVideoPrompt, validateSubShots,
  dialogueSpeakerNames, MAX_SPEAKERS_PER_SHOT,
  SHOT_DIALOGUE_MAX_RATE, SHOT_DURATION_MIN, SHOT_DURATION_MAX, SHOT_DURATION_DEFAULT,
  fallbackAssetPrompt, llmChat, extractJson, CHARACTER_T2I_LAYOUT_CONSTRAINT,
  imageToDataUrl, buildVisionUserMessage,
  runWorkflow, pickOutput, downloadToFile, getSpecForKind, uploadTaskInput,
  mergeVideos, withWriteContext, buildSrt, renderConcurrencyLimit, inferVideoMode,
  recordUsage, priceForKind, walletEnabled, holdCredits, captureHold,
} from '../core/index.js';
import { PROJECT_ASSET_SUBDIRS, ASSET_CATEGORY_IDS, ratioToSize, inferVoiceBaseline, filterReferenceImages, CONTEXT_KEYS, textMentions, isVariantAssetCategory, VIDEO_MODES } from '../shared/index.js';
import { loadSkillWithResources, renderSkillContent } from './skill-engine.js';
import { guardToolCall } from './guard.js';
import { searchWeb, searchImages, downloadImageSafe } from './search.js';

// ================= 工具定义（OpenAI function-calling） =================
export const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'skill', description: '加载一个可用技能的完整说明与参考文件索引，返回技能正文后严格遵循；需要某个参考文件全文时再用 skill_reference。命中以下任务前必须先调用：写视频提示词→skill(h3-prompt-writing)；拆分镜脚本→skill(story-pipeline-cn)；写图片/图生图提示词→skill(image-prompt-writing)；设计人物音色→skill(tts-voice-design)；总流水线→skill(novel-to-video)。短剧/漫剧：短剧编剧→skill(0715-scriptwriter)；剧本总控→skill(script-master)；小说改编→skill(novel-to-skitscreenplay)；转分镜→skill(novel-to-storyboard)；文字分镜JSON→skill(hf-drama-storyboard-script)；漫剧策划→skill(ai-manga-planner)；漫剧导演→skill(manju-director-agent)；漫剧全流程→skill(manga-drama-generator)；脚本转漫剧→skill(script-to-manga)；分镜解析→skill(comic-drama-generator)；镜头库/影视级→skill(cinematic-ai-comic-director)；道具年代一致→skill(era-consistency-optimizer)；全栈分镜提示词→skill(manga-full-stack)。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'skill_reference', description: '加载某技能 references 目录下的单个参考文件全文（例如 skill_reference(name="script-master", ref="framework.md")）。先用 skill() 查看该技能的参考文件索引，再按需加载单个文件。', parameters: { type: 'object', properties: { name: { type: 'string' }, ref: { type: 'string' } }, required: ['name', 'ref'] } } },
  { type: 'function', function: { name: 'get_project', description: '读取当前项目信息与上下文摘要（人物圣经/风格指南/连续性记录），含章节列表。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_chapters', description: '列出项目章节（每章的标题/序号/状态/该章分镜数）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'save_context', description: '写入项目上下文文件：bible（人物圣经）/ style（风格指南）/ continuity（连续性记录，追加）。', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['bible', 'style', 'continuity'] }, content: { type: 'string' } }, required: ['key', 'content'] } } },
  { type: 'function', function: { name: 'report', description: '向任务进度汇报一条状态（阶段/详情）。', parameters: { type: 'object', properties: { phase: { type: 'string' }, detail: { type: 'string' } }, required: ['detail'] } } },
  { type: 'function', function: { name: 'list_assets', description: '列出项目资产，可按分类过滤。返回含 prompt/prompt_used/prompt_locked（prompt_locked=1 表示这是用户手动保存的提示词，权威，不要覆盖）。', parameters: { type: 'object', properties: { category: { type: 'string', enum: ASSET_CATEGORY_IDS } } } } },
  { type: 'function', function: { name: 'create_asset', description: '创建资产（人物/场景/道具/语音/其他）。category=costume（服装）/age（年龄）是「挂在角色下的变体」，必须用 parent_id 指向本项目的角色资产；否则该变体在生成阶段会被静默忽略（refs.js 只按 parent_id 把它映射到角色）。更推荐直接用 change_outfit/design_outfits（服装）或 change_age/design_ages（年龄）生成变体。', parameters: { type: 'object', properties: { category: { type: 'string', enum: ASSET_CATEGORY_IDS }, name: { type: 'string' }, description: { type: 'string' }, voice_desc: { type: 'string', description: '人物声音特征描述（仅人物）：性别+年龄段+音色质感，如「青年男性，嗓音低沉」。后续 design_voice 会优先用它作为音色描述。' }, parent_id: { type: 'string', description: '仅服装（costume）/年龄（age）变体需要：所挂角色（character）资产的 id。缺了会被拒绝。' } }, required: ['category', 'name'] } } },
  { type: 'function', function: { name: 'update_asset', description: '更新资产字段（描述/提示词/参考语音/一致性锚点）。注意：用户若在素材库手动保存过该资产的提示词（prompt_locked=1），本工具不会覆盖它，只会更新其他字段——不要试图用本工具改写用户手写的提示词。', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, voice_desc: { type: 'string', description: '人物声音特征描述：性别+年龄段+音色质感，如「青年男性，嗓音低沉」。' }, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, voice_ref: { type: 'string' }, consistency_key: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'generate_asset_image', description: '文生图生成资产图片（Qwen-Image-2512）。prompt 为空时用资产描述兜底。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, ratio: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'edit_asset_image', description: '图生图/图像编辑（Qwen-Image-Edit-2511）：以参考图 + 指令生成新图，用于一致性变体。reference_asset_id 传资产 id、reference_image_path 传参考图相对路径（二者选一，缺省用资产自身图）。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, prompt: { type: 'string' }, reference_asset_id: { type: 'string' }, reference_image_path: { type: 'string' } }, required: ['asset_id', 'prompt'] } } },
  { type: 'function', function: { name: 'change_outfit', description: '人物换装：以角色 canonical 参考图为参考，用图生图（Qwen-Image-Edit）生成该角色的一套新服装资产（category=costume，parent_id 指向角色），供分镜按章引用。label 为服装短名（如「进城旧衣」），用于资产命名与分镜引用；outfit 为服装外观描述。剧情出现沐浴/洗澡/更衣/换衣/换装/换上(新)衣等换装事件后，必须调用本工具为该角色生成新服装，并在换装事件之后的镜头用 set_storyboard 的 costumes 字段引用。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, outfit: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' } }, required: ['character_id', 'outfit'] } } },
  { type: 'function', function: { name: 'design_outfits', description: '仅当剧情需要（出现换装事件，或同一角色在不同场景需不同着装）时才调用。给角色一次性设计并生成多套服装资产（衣橱）：以角色 canonical 参考图为参考，用图生图为每套服装生成一张服装图（category=costume，parent_id 指向角色），供分镜按服装名引用对应那套。剧情没有换装需求的角色不要调用（直接用 canonical 图，避免素材冗余）。outfits 传该角色的多套服装清单，每套含 name（服装短名，如「进城旧衣」「沐浴后家居服」「金缕阁新衣」）与 description（服装外观描述）。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, outfits: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] } } }, required: ['character_id', 'outfits'] } } },
  { type: 'function', function: { name: 'change_age', description: '人物年龄变体：以角色 canonical 参考图为参考，用图生图（Qwen-Image-Edit）生成该角色某一时期/年龄的样貌（category=age，parent_id 指向角色），保持脸/五官/发型/画风一致、只改年龄，供回忆/时间跳跃镜头按章引用。label 为年龄短名（如「年轻」「中年」「老年」），用于资产命名与分镜引用；age 为年龄/时期外观描述。剧情出现回忆/时光倒流/多年后等年龄变化后，必须调用本工具为该角色生成对应年龄变体，并在时间跳跃之后的镜头用 set_storyboard 的 ages 字段引用。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, age: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' } }, required: ['character_id', 'age'] } } },
  { type: 'function', function: { name: 'design_ages', description: '仅当剧情需要展示角色不同年龄段/时期（回忆/时间跳跃/年龄变化）时才调用。给角色一次性设计并生成多个年龄变体：以角色 canonical 参考图为参考，用图生图为每个时期生成一张年龄变体图（category=age，parent_id 指向角色），供分镜按变体名引用。剧情没有年龄变化的角色不要调用（直接用 canonical 图，避免素材冗余）。ages 传该角色的多个时期清单，每项含 name（年龄短名，如「年轻」「中年」「老年」）与 description（年龄/时期外观描述）。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, ages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] } } }, required: ['character_id', 'ages'] } } },
  { type: 'function', function: { name: 'view_asset', description: '查看某资产的参考图（视觉模型）：返回资产元数据与图片块；模型不支持图片输入时仅返回文本。', parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'view_shot_references', description: '查看某分镜的参考素材图（角色/场景/道具/服装，视觉模型）：返回清单与 ≤9 张参考图；模型不支持图片输入时仅返回文本。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'view_project_references', description: '查看用户上传的参考图片素材（视觉模型）：返回参考图清单与图片块，据此分析其内容/画风/元素并生成风格与设定一致的新素材；模型不支持图片输入时仅返回文本清单。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'register_voice', description: '登记资产（人物）的参考音色文件名（相对项目 assets/voice/）。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, voice_ref: { type: 'string' } }, required: ['asset_id', 'voice_ref'] } } },
  { type: 'function', function: { name: 'design_voice', description: '用 Qwen3 TTS 音色设计工作流为人物设计音色：text 是人物朗读的简短自我介绍文案（20~30 字，约 5 秒，禁止长篇大论），voice_description 是音色描述（不限制字数，可详细写；必须包含性别与年龄段，如「青年男性，嗓音低沉」，缺失会导致音色性别/年龄错乱）。生成语音样本并存为该项目 voice_ref。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, text: { type: 'string', description: '人物朗读的简短自我介绍，20~30 字，约 5 秒' }, voice_description: { type: 'string', description: '音色描述，不限制字数，必须包含性别与年龄段' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'generate_assets_batch', description: '按工作流类型分批统一生成项目素材：先文生图全部图片类资产（人物/场景/道具），再设计全部人物音色（Qwen3-TTS）。批次会一次性排入渲染槽位并发提交，实际并发上限由渲染槽位决定（RunningHub 按 runninghubConcurrency，本地 ComfyUI 恒为 1）。已生成成功的资产自动跳过（幂等）。only 可传 ["image"] 或 ["tts"] 只跑其中一类（用于把两类分到不同的 ComfyUI 实例）。', parameters: { type: 'object', properties: { only: { type: 'array', items: { type: 'string', enum: ['image', 'tts'] } } } } } },
  { type: 'function', function: { name: 'generate_asset_from_reference', description: '以某张用户上传的参考图为输入，用图生图（Qwen-Image-Edit）生成一个新素材资产（category/name 指定）。用于「参考生成新素材」：先分析参考图内容/风格，再据此派生新素材。category=costume/age 属「挂在角色下的变体」，必须用 parent_id 指向本项目的角色资产。', parameters: { type: 'object', properties: { reference_id: { type: 'string' }, category: { type: 'string', enum: ASSET_CATEGORY_IDS }, name: { type: 'string' }, prompt: { type: 'string' }, description: { type: 'string' }, parent_id: { type: 'string', description: '仅服装（costume）/年龄（age）变体需要：所挂角色（character）资产的 id。' } }, required: ['reference_id', 'category', 'name'] } } },
  { type: 'function', function: { name: 'set_storyboard', description: '写入/追加分镜列表（按章内 idx upsert，非破坏：已生成的分镜保留 status/video，新增章节按更高 idx 追加；每章分镜编号 idx 独立从 1 开始，不要跨章连续编号）。characters/scenes/props/costumes/ages/audios 传资产名数组（costumes 为换装后的服装资产名，沐浴/更衣/换装事件之后的镜头必须引用对应服装，事件之前的镜头不引用；ages 为年龄/时期变体资产名，回忆/时间跳跃镜头引用对应时期；audios 为独立音频素材名——旁白音色/背景音乐/音效，作为 H3 音色参考输入，有旁白的分镜引用旁白音色）；chapter 传章节标题或章节 id（先用 list_chapters 看本项目章节）；narration 传该镜旁白口播稿（没有旁白留空）。硬约束：dialogue 字数必须 ≤ duration×5（中文旁白约 4-5 字/秒），超长会被拒绝，需缩短台词或拆镜；每个分镜最多 2 个说话人，≥3 人对话会被拒绝，需拆成多个分镜（参考音频只提交有台词角色，单分镜 ≤3 段）。', parameters: { type: 'object', properties: { shots: { type: 'array', items: { type: 'object', properties: { idx: { type: 'number' }, chapter: { type: 'string' }, scene_name: { type: 'string' }, duration: { type: 'number' }, characters: { type: 'array', items: { type: 'string' } }, scenes: { type: 'array', items: { type: 'string' } }, props: { type: 'array', items: { type: 'string' } }, costumes: { type: 'array', items: { type: 'string' } }, ages: { type: 'array', items: { type: 'string' } }, audios: { type: 'array', items: { type: 'string' } }, sub_shots: { type: 'string' }, dialogue: { type: 'string' }, narration: { type: 'string' }, camera: { type: 'string' }, visual: { type: 'string' }, mode: { type: 'string', description: '生成模式（缺省 auto=按参考素材自动推断）：reference=参考生视频（多图+音视频）；image=图生/首尾帧（0-2 张图：1 张=图生，2 张=首尾帧）；text=文生视频（不连接任何媒体节点，忽略参考素材）；digital_human=数字人（预留，暂不对接业务）' } } } }, clear: { type: 'boolean', description: '只清空本次写入涉及章节的现有分镜（按 idx 重写本章），其他章节的分镜一律保留；省略=追加/更新' } }, required: ['shots'] } } },
  { type: 'function', function: { name: 'list_shots', description: '列出项目分镜及其状态。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'update_shot', description: '更新某分镜字段（video_prompt 为按 h3-prompt-writing 技能写好的 H3 视频提示词，生成视频前必须先写入）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, sub_shots: { type: 'string' }, dialogue: { type: 'string' }, narration: { type: 'string' }, camera: { type: 'string' }, visual: { type: 'string' }, duration: { type: 'number' }, video_prompt: { type: 'string' }, mode: { type: 'string', description: '生成模式（缺省 auto=按参考素材自动推断）：reference=参考生视频（多图+音视频）；image=图生/首尾帧（0-2 张图）；text=文生视频（不连接任何媒体节点）；digital_human=数字人（预留，暂不对接业务）' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'generate_shot_video', description: '为某分镜生成视频（MiniMax H3 Ref2VA）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'regenerate_shot', description: '重新生成某分镜视频，可带反馈文字（如「镜头拉近/让人物微笑」）。render=false 时只用 LLM 按反馈改写 video_prompt，不提交 ComfyUI 渲染。append=true 时把新视频追加为该分镜的新候选（保留旧候选），默认 false 为替换整批候选。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, feedback: { type: 'string' }, render: { type: 'boolean', description: 'false=只做 LLM 改写提示词，不渲染视频；默认 true' }, append: { type: 'boolean', description: 'true=追加为新候选（保留旧候选），false=替换整批候选（默认）' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'generate_chapter_videos', description: '为指定章节一次性生成/补齐全部镜头视频（确定性批量循环，不省略任何镜头）；无依赖关系的镜头会并发提交，引用资产尚未生成完成的镜头会暂缓（deferred）且不提交渲染；force=true 时强制重生成本章全部视频（含已 done）。失败的镜头标记为 failed 并继续，直到该章所有可跑镜头有结果。不受步数/时长限制。', parameters: { type: 'object', properties: { chapter: { type: 'string' }, force: { type: 'boolean' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'assemble_video', description: '用 ffmpeg 合并本章分镜视频为成片，并垫入该章背景音乐（若有）。chapter 缺省时合并全部分镜（不混背景音乐）。', parameters: { type: 'object', properties: { chapter: { type: 'string' } } } } },
  { type: 'function', function: { name: 'set_chapter_music', description: '为指定章节撰写背景音乐：caption 为结构化音乐风格描述（先加载 skill(ai-music-studio) 与 skill(music-caption-rewriter)，按其规范产出贴合本章剧情的 Global Metadata / Vocal Details / Arrangement），lyrics 为歌词（用适合本章剧情的语言：华语普通话/粤语/英语等），duration 为合适时长秒数。写入章节记录，后续 generate_music 据此生成。', parameters: { type: 'object', properties: { chapter: { type: 'string' }, caption: { type: 'string' }, lyrics: { type: 'string' }, duration: { type: 'number' } }, required: ['chapter', 'caption', 'lyrics'] } } },
  { type: 'function', function: { name: 'generate_music', description: '为指定章节生成带歌词的背景音乐（MiniMax Music3）。读取该章已写好的 caption/lyrics/duration（未写则用项目风格兜底、无歌词）。', parameters: { type: 'object', properties: { chapter: { type: 'string' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'generate_music_asset', description: '为一条已创建的背景音乐资产（asset_id）生成音频。资产的 prompt（caption）/lyrics/max_duration 已写好；生成完成后写入音频并置 done，失败置 failed。', parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'apply_chapter_music', description: '把音乐库中选定的背景音乐（music_id）应用到多个章节（chapters 数组，仅已全部生成完成的章节会应用），并重新合成各章成片。', parameters: { type: 'object', properties: { music_id: { type: 'string' }, chapters: { type: 'array', items: { type: 'string' } } }, required: ['music_id', 'chapters'] } } },
  { type: 'function', function: { name: 'list_workflows', description: '列出已注册的 ComfyUI 工作流。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索。type=web 查资料/确认事实；type=image 搜参考图片（返回图片 URL 数组）。遇到你不知道或不确凿的事实——品牌名、产品型号、年代物品的真实外观、专业术语、历史/地理/科技细节、真实存在的服饰/道具样式等——必须先查证再写，禁止凭空臆造年代/品牌/型号错误。需要某物品/服饰的参考图时用 type=image 搜图，再配 download_reference_image 下载为参考图。若设置里关闭了联网搜索，本工具会返回 disabled（此时改用既有知识继续，不要重试）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, type: { type: 'string', enum: ['web', 'image'], description: 'web=文字资料搜索（默认），image=图片搜索' }, engine: { type: 'string', description: 'type=web 时指定引擎 id 逗号分隔（如 bing-cn,baidu）；省略用国内引擎组合' }, limit: { type: 'number', description: '返回条数上限，默认 8' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'download_reference_image', description: '把一张图片 URL 下载到本项目参考图（references/），登记为参考素材（origin=downloaded），供「资产图」阶段用图生图（generate_asset_from_reference）派生新素材。常用于把 web_search(type=image) 搜到的参考图（老电话/手机型号/服装等）落地。仅 http/https，下载会被 SSRF/大小/类型校验拦截。', parameters: { type: 'object', properties: { url: { type: 'string', description: '图片 URL（http/https）' }, name: { type: 'string', description: '参考图名称，如「诺基亚3310老手机」；缺省取 URL 文件名' }, category: { type: 'string', enum: ASSET_CATEGORY_IDS, description: '素材分类，默认 prop' }, description: { type: 'string', description: '参考图用途/内容描述' } }, required: ['url'] } } },
];

// 封闭参数白名单：从 TOOL_DEFINITIONS 的 parameters.properties 派生每个工具的顶层参数键。
// 对齐「未知字段=硬错误」原则：模型幻觉出多余字段时直接拒绝，避免「看似成功实则写错字段」。
// 工具 schema 是唯一权威来源，不另维护一份清单，防止漂移。
const ALLOWED_ARG_KEYS = new Map(
  TOOL_DEFINITIONS.map((t) => [t.function.name, new Set(Object.keys(t.function.parameters?.properties || {}))])
);

// ================= 运行时上下文 =================
// 需要拉起外部进程（ComfyUI / ffmpeg）的渲染类工具。
// 本机 LLM 与 ComfyUI 无法同时常驻（27B GGUF 15.66GB 与 H3 出图峰值叠加会爆显存），
// 故「只跑 LLM 文本」的阶段靠这张表在 runTool 层硬拦，见 runTool 的 renderDisabled 分支。
export const RENDER_TOOLS = new Set([
  'generate_asset_image', 'edit_asset_image', 'change_outfit', 'design_outfits',
  'change_age', 'design_ages',
  'generate_assets_batch', 'design_voice', 'generate_shot_video',
  'generate_asset_from_reference',
  'regenerate_shot', 'generate_chapter_videos', 'assemble_video',
  'generate_music', 'generate_music_asset', 'apply_chapter_music',
  'generate_video_asset',
]);

// 走 generate_assets_batch 文生图的资产类别。服装走 change_outfit/design_outfits（图生图），
// 不在此列 —— stages.pendingByStage 复用本常量，保证「待办数」与「实际会做什么」永远一致。
export const IMAGE_ASSET_CATEGORIES = ['character', 'scene', 'prop', 'other'];

// Qwen-Image 2.1 / Krea2 文生图工作流：生成「人物素材」时需强制注入统一构图约束（见 CHARACTER_T2I_LAYOUT_CONSTRAINT）
const CHARACTER_T2I_WORKFLOWS = new Set(['krea2_hyperreal_t2i', 'qwen_image_2_1_t2i_api', 'qwen_image_2_1_t2i_gguf']);

export function createToolRuntime({ projectId, jobId, onProgress, isAborted, chapter, renderDisabled, llmDisabled }) {
  const cfg = loadConfig();
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在：' + projectId);
  ensureProjectDirs(projectId);
  return {
    cfg, project, projectId, jobId,
    chapter: chapter || '',
    renderDisabled: !!renderDisabled,
    // 与 renderDisabled 对称：渲染阶段 / 纯渲染任务置 true → 禁止调用 LLM。
    // LLM 与 ComfyUI 单卡不能同时常驻（见 stages.js 设计说明），故换装/年龄的视觉精修、
    // 视频提示词 LLM 改写等可选 LLM 步骤在此下跳过或直接拒绝。
    llmDisabled: !!llmDisabled,
    onProgress: onProgress || (() => {}),
    isAborted: isAborted || (() => false),
    report(patch) {
      if (this.onProgress) this.onProgress(patch);
      logger.info('agent: ' + (patch.phase || '') + ' ' + (patch.detail || ''), patch);
    },
  };
}

// 导出/合成计费：由后台 billing.chargeExport 控制；只在服务端合成成功时记一次，下载不另收。
async function recordExportUsage(ctx, quantity) {
  try {
    if (!(Number(quantity) > 0)) return;
    const cfg = ctx.cfg || loadConfig();
    const b = cfg.billing || {};
    if (!b.chargeExport) return;
    const ownerId = Projects.ownerOf(ctx.projectId) || '';
    if (!ownerId) return;
    const price = priceForKind(cfg, 'export', quantity);
    if (!(price.amount > 0)) return;
    const chapter = ctx.chapter || '';
    const subject = chapter || '导出';
    if (walletEnabled(cfg)) {
      // 钱包模式：合成已经发生，但这里仍然先 hold 再立即 capture；余额不够会抛错并暂停任务，
      // 不会出现“导出了但没扣分”的静默漏计。
      const hold = holdCredits({
        ownerId, amount: price.amount, key: 'export:' + uid(), jobId: ctx.jobId,
        projectId: ctx.projectId, kind: 'export', chapter, subject,
      }, cfg);
      captureHold(hold.id, { cfg, quantity, unitPrice: price.unitPrice, chapter, subject });
      return;
    }
    await recordUsage(
      { projectId: ctx.projectId, ownerId, jobId: ctx.jobId, kind: 'export', quantity, unitPrice: price.unitPrice, currency: price.currency, chapter, subject },
      cfg,
    );
  } catch (e) {
    if (e && e.code === 'INSUFFICIENT_CREDITS') throw e;
    /* 记账失败不影响导出结果 */
  }
}

// ================= 内部辅助 =================
function saveToProject(ctx, relPath, buf) {
  const abs = resolveProjectPath(ctx.projectId, relPath);
  if (!abs) throw new Error('非法保存路径：' + relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return relPath;
}

async function downloadOutputTo(ctx, out, relPath) {
  const abs = resolveProjectPath(ctx.projectId, relPath);
  if (!abs) throw new Error('非法输出路径：' + relPath);
  return downloadToFile(ctx.cfg, out, abs);
}

function assetFallback(asset, project) {
  return fallbackAssetPrompt({ type: asset.category, name: asset.name, description: asset.description, style: project.style });
}

export function visionEnabled(ctx) { return !!(ctx.cfg?.llm?.vision); }

// 把本地图片绝对路径列表转成 { data, mimeType } 图片块（视觉模型投喂），跳过不可读/超大文件
// 视觉投喂的参考图做限流：默认最多 6 张、单张 ≤2.5MB，避免大量超大图把对话上下文撑爆，
// 进而触发 openclaude 的 active-message 安全上限（自动压缩压不动时直接停跑）。
function imagesFromPaths(absPaths, max = 6) {
  const out = [];
  for (const p of (absPaths || [])) {
    if (out.length >= max) break;
    if (!p) continue;
    const img = imageToDataUrl(p, { maxBytes: 2.5 * 1024 * 1024 });
    if (img) out.push(img);
  }
  return out;
}

// 超时预算按本机实测吞吐给：视频单条 15-30 分钟，且 ComfyUI 队列串行，
// 超时必须覆盖排队等待，否则产物已生成却无人回收。
const IMG_TIMEOUT = (cfg) => (Number(cfg?.generation?.imageTimeoutMinutes) || 30) * 60 * 1000;
const VID_TIMEOUT = (cfg) => (Number(cfg?.generation?.videoTimeoutMinutes) || 120) * 60 * 1000;

// ================= 工具处理函数 =================
// 章节进度摘要（列表里带 shotCount/doneCount/genStatus）统一走 lib/core 的 chapterStats：
// 界面路由 GET /api/projects/:id/chapters 用的是同一份，避免「生成中」判定这种口径再各写一遍。
async function hGetProject(ctx) {
  const assets = Assets.list(ctx.projectId);
  const shots = Shots.list(ctx.projectId);
  return JSON.stringify({
    project: { id: ctx.project.id, name: ctx.project.name, style: ctx.project.style, video_resolution: ctx.project.video_resolution, video_aspect_ratio: ctx.project.video_aspect_ratio, enable_bgm: ctx.project.enable_bgm !== false },
    context: ctx.project.context || {},
    chapters: Chapters.list(ctx.projectId).map((c) => { const st = chapterStats(ctx.projectId, c.title); return { id: c.id, title: c.title, seq: c.seq, status: c.status, novel: c.novel, shotCount: st.total, doneCount: st.done, genStatus: st.status }; }),
    assets: assets.map((a) => ({ id: a.id, category: a.category, name: a.name, image_path: a.image_path, voice_ref: a.voice_ref, voice_desc: a.voice_desc, parent_id: a.parent_id || '', source: a.source || '', status: a.status })),
    shots: shots.map((s) => ({ id: s.id, idx: s.idx, chapter: s.chapter || '', scene_name: s.scene_name, status: s.status, has_prompt: !!(s.video_prompt && String(s.video_prompt).trim()), video_path: s.video_path })),
  });
}
async function hListChapters(ctx) {
  return JSON.stringify(Chapters.list(ctx.projectId).map((c) => { const st = chapterStats(ctx.projectId, c.title); return { id: c.id, title: c.title, seq: c.seq, status: c.status, novel: c.novel, shotCount: st.total, doneCount: st.done, genStatus: st.status }; }));
}

async function hSaveContext(ctx, args) {
  // key 值域与工具 schema 的 enum、以及 PUT /api/projects/:id/context 的 400 口径一致。
  // 不校验的话：key='bible2' 之类会当 style.md 落盘（写坏风格指南文件），DB 里却多出一个野键。
  if (!CONTEXT_KEYS.includes(args.key)) {
    throw new Error('key 只能是 ' + CONTEXT_KEYS.join('/') + '（当前：' + args.key + '）');
  }
  const dir = path.join(projectDir(ctx.projectId), 'context');
  fs.mkdirSync(dir, { recursive: true });
  if (args.key === 'continuity') {
    const f = path.join(dir, 'continuity.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    // 文件可能是被手改坏的非数组 JSON：直接 push 会抛 TypeError，整次写入失败。
    // 与路由侧（context/route.js）一致，非数组一律当空列表重来。
    if (!Array.isArray(arr)) arr = [];
    arr.push({ t: Date.now(), content: args.content });
    fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  } else {
    const f = path.join(dir, args.key === 'bible' ? 'bible.md' : 'style.md');
    fs.writeFileSync(f, args.content);
  }
  // 多章节并行时，各 Agent 手里的 ctx.project.context 可能是旧快照。
  // 只合并本次写入的 key，避免整段覆盖掉另一章刚写的 bible/style/continuity。
  const fresh = Projects.setContextKey(ctx.projectId, args.key, args.content);
  if (fresh) ctx.project.context = fresh;
  return '已保存上下文：' + args.key;
}

async function hLoadSkill(ctx, args) {
  const name = args.name;
  const skill = loadSkillWithResources(name);
  if (!skill) throw new Error('技能不存在：' + name);
  const NL = String.fromCharCode(10);
  const parts = [renderSkillContent(skill)];
  if (skill.references && skill.references.length) {
    parts.push('【技能参考文件索引】需要某个文件全文时，调用 skill_reference(name="' + name + '", ref="<文件名>")：');
    for (const r of skill.references) {
      const preview = String(r.content || '').slice(0, 160).replace(/\s+/g, ' ');
      parts.push('- ' + r.name + '（约 ' + r.content.length + ' 字）' + (preview ? '：' + preview : ''));
    }
  }
  const content = parts.join(NL + NL);
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hSkillReference(ctx, args) {
  const skill = loadSkillWithResources(args.name);
  if (!skill) throw new Error('技能不存在：' + args.name);
  const refs = skill.references || [];
  const ref = refs.find((r) => r.name === args.ref);
  if (!ref) throw new Error('参考文件不存在：' + args.ref + '。可用：' + refs.map((r) => r.name).join(', '));
  const content = String(ref.content || '');
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hReport(ctx, args) {
  ctx.report({ phase: args.phase || '', detail: args.detail || '' });
  return '已汇报';
}

async function hListAssets(ctx, args) {
  const assets = Assets.list(ctx.projectId, args.category);
  // 必须带上 prompt / prompt_used：LLM 看不到用户已保存的提示词，就会以为自己才是第一个写的人，
  // 用 update_asset 把用户的提示词覆盖掉（「保存了提示词却不生效」的一大来源）。
  return JSON.stringify(assets.map((a) => ({
    id: a.id, category: a.category, name: a.name, description: a.description, voice_desc: a.voice_desc,
    prompt: a.prompt || '', prompt_used: a.prompt_used || '', prompt_locked: a.prompt_locked ? 1 : 0,
    image_path: a.image_path, voice_ref: a.voice_ref, parent_id: a.parent_id || '', source: a.source || '', status: a.status,
  })));
}

// 资产写入前的 parent_id 统一校验（Agent 工具侧）：
//   变体（服装/年龄）：必须用 parent_id 指向本项目的角色素材。refs.js 只按 parent_id 把变体映射到
//     角色（镜头里有该角色时才拿它替换角色参考图），缺父/父不是角色的变体在生成阶段被完全忽略，
//     却照样出现在素材库与分镜引用列表里 —— 用户以为绑上了、分镜也「更新成功」，实际静默无效。
//     db 层 Assets.create 会抛 BAD_VARIANT_PARENT，但那是「模型看不懂的 DB 错误」，这里给出可读指引，
//     把 LLM 引导到只干这件事的专用工具（change_outfit / design_outfits / change_age / design_ages）。
//   非变体分类：parent_id 无意义（只会让 Assets.remove 把它当子变体级联删、usageOf 把它计成 children），
//     传了就直接拒绝，绝不静默丢弃（静默丢弃 = 模型以为写成功，是同一类坑）。
function resolveAssetParent(ctx, category, parentId) {
  const pid = String(parentId || '').trim();
  if (!isVariantAssetCategory(category)) {
    if (pid) throw new Error('parent_id 只能用于服装（costume）/年龄（age）变体；' + category + ' 不挂在其它素材下，请去掉 parent_id');
    return '';
  }
  const parent = pid ? Assets.get(pid) : null;
  if (!parent || parent.project_id !== ctx.projectId || parent.category !== 'character') {
    const hint = category === 'costume'
      ? '生成服装建议改用 change_outfit / design_outfits（会以角色 canonical 图为参考出图）'
      : '生成年龄变体建议改用 change_age / design_ages（会以角色 canonical 图为参考出图）';
    throw new Error('服装/年龄变体必须用 parent_id 绑定到本项目的一个角色（character）资产；' + hint);
  }
  return pid;
}

async function hCreateAsset(ctx, args) {
  const parentId = resolveAssetParent(ctx, args.category, args.parent_id);
  const isVariant = isVariantAssetCategory(args.category);
  // 幂等：同分类+同名资产已存在则复用，避免续跑时重复建。
  // 变体（服装/年龄）还要按 parent_id 区分：同一套「旧衣」可能是不同角色各自的，
  // 只按 name 复用会把 A 角色的服装错算成 B 角色的（refs.js 按 parent_id 映射，挂到别的角色上）。
  const existing = Assets.list(ctx.projectId, args.category).find((a) => a.name === args.name && (!isVariant || (a.parent_id || '') === parentId));
  if (existing) {
    // 续跑复用：此前没写声音画像而这次提供了，补上（否则设计音色仍会性别错乱）
    if (existing.category === 'character' && args.voice_desc && !(existing.voice_desc || '').trim()) {
      Assets.update(existing.id, { voice_desc: args.voice_desc });
      logger.info('续跑资产补 voice_desc：' + existing.name);
    }
    return JSON.stringify({ id: existing.id, category: existing.category, name: existing.name, parent_id: existing.parent_id || '', reused: true, status: existing.status, image_path: existing.image_path });
  }
  const a = Assets.create(ctx.projectId, { category: args.category, name: args.name, description: args.description || '', voice_desc: args.voice_desc || '', parent_id: parentId });
  return JSON.stringify({ id: a.id, category: a.category, name: a.name, parent_id: a.parent_id || '', voice_desc: a.voice_desc });
}

// 用户在前端「素材库」手动保存过的提示词（prompt_locked=1）是权威，LLM 不得覆盖：
// 否则用户改完提示词、再跑一次 LLM 阶段，提示词就被 LLM 重写回去了（用户看到的现象就是「改了不生效」）。
// 想把提示词交回给 LLM 改写，只需在素材库里把提示词清空保存（清空即解锁）。
export function keepsUserPrompt(asset) {
  return !!(asset && asset.prompt_locked && String(asset.prompt || '').trim());
}

async function hUpdateAsset(ctx, args) {
  const patch = {};
  for (const k of ['name', 'description', 'voice_desc', 'prompt', 'negative_prompt', 'voice_ref', 'consistency_key']) {
    if (args[k] != null) patch[k] = args[k];
  }
  const asset = Assets.get(args.id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在：' + args.id);
  let keptPrompt = false;
  const imgBusy = Queue.activeByDedupe('asset:' + asset.id);
  const voiceBusy = Queue.activeByDedupe('voice:' + asset.id);
  const deferred = [];
  // 正在渲染时不要改输入：否则出来的图/音色对应的是旧提示词，下一阶段又会重做一遍。
  if (patch.prompt != null && imgBusy) { delete patch.prompt; deferred.push('prompt'); }
  if (patch.voice_desc != null && voiceBusy) { delete patch.voice_desc; deferred.push('voice_desc'); }
  if (patch.prompt != null && keepsUserPrompt(asset) && String(patch.prompt) !== String(asset.prompt)) {
    delete patch.prompt;
    keptPrompt = true;
  }
  Assets.update(args.id, patch);
  if (deferred.length) {
    return '已更新资产 ' + args.id + '（' + deferred.join('/') + ' 正在渲染，本次未改动；请等渲染结束后再更新，避免成品与提示词不一致）';
  }
  return keptPrompt
    ? ('已更新资产 ' + args.id + '（提示词保持用户手写版本不变：素材库里手动保存的提示词优先于 LLM；如需让 LLM 改写，请在素材库把该资产的提示词清空保存）')
    : ('已更新资产 ' + args.id);
}

// 其他章节正在渲染同一素材时，等待它完成，而不是立刻跳过：
// 跳过会让本批以为素材已就绪，后续视频阶段又因缺图失败/重试。最多等到队列超时。
async function waitForActiveRender(dedupeKey, isAborted, maxMs = 30 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (isAborted && isAborted()) throw new Error('任务已停止（等待其他任务完成渲染）');
    if (!Queue.activeByDedupe(dedupeKey)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function assetImageReady(asset) {
  return !!(asset && asset.image_path && asset.status === 'done' && (asset.prompt_used || '') === (asset.prompt || ''));
}

async function hGenerateAssetImage(ctx, args) {
  let asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  const dedupeKey = 'asset:' + asset.id;
  if (Queue.activeByDedupe(dedupeKey)) {
    if (!(await waitForActiveRender(dedupeKey, ctx.isAborted))) throw new Error('等待其他任务完成该素材渲染超时');
    asset = Assets.get(asset.id) || asset;
    if (assetImageReady(asset)) {
      return JSON.stringify({ asset_id: asset.id, skipped: true, reason: '其他任务已完成该素材生成' });
    }
  }
  const fb = assetFallback(asset, ctx.project);
  // 资产自身的提示词优先（用户编辑过 / LLM 阶段写过的，都应盖过调用方这次的临时 prompt），args.prompt 仅作兜底
  const prompt = asset.prompt || args.prompt || fb.prompt;
  const negative_prompt = asset.negative_prompt || args.negative_prompt || fb.negative_prompt;
  // 按资产类型选合适尺寸：人物三视图/场景用 16:9，道具白底用 1:1，其余默认 16:9；可用参数 args.ratio 覆盖
  const RATIO_BY_CATEGORY = { character: '16:9', scene: '16:9', prop: '1:1', other: '16:9' };
  const ratio = args.ratio || RATIO_BY_CATEGORY[asset.category] || '16:9';
  const [w, h] = ratioToSize(ratio);
  const spec = getSpecForKind(ctx.cfg, 't2i');
  // Qwen-Image 2.1 / Krea2 文生图生成「人物素材」时，强制注入统一构图约束（白底 + 左1/3面部特写 + 右2/3三视图）
  const positive_prompt = asset.category === 'character' && CHARACTER_T2I_WORKFLOWS.has(spec.id) && !prompt.includes('左侧1/3')
    ? prompt + '\n' + CHARACTER_T2I_LAYOUT_CONSTRAINT
    : prompt;
  const prefix = 'assets/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  const prevImage = asset.image_path || '';
  const restoreAsset = (error = '') => Assets.update(asset.id, { status: prevImage ? 'done' : 'failed', error });
  ctx.report({ phase: '资产生成', detail: '文生图：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  let outputs;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ outputs } = await runWorkflow(ctx.cfg, spec, {
        positive_prompt, negative_prompt, width: w, height: h, seed: randomSeed(), filename_prefix: prefix,
      }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: '', subject: asset.name || asset.id, dedupeKey, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } }));
      break;
    } catch (e) {
      // 流水线 / 手动入口并发提交同一资产：等先到的任务完成；若已完成则跳过，不重复扣费。
      if (e && e.code === 'DUPLICATE_RENDER' && attempt === 0) {
        const ok = await waitForActiveRender(dedupeKey, ctx.isAborted);
        if (!ok) { restoreAsset('等待其他任务完成该素材渲染超时'); throw new Error('等待其他任务完成该素材渲染超时'); }
        const fresh = Assets.get(asset.id);
        if (assetImageReady(fresh)) {
          Assets.update(asset.id, { status: 'done', error: '' });
          return JSON.stringify({ asset_id: asset.id, skipped: true, reason: '其他任务已完成该素材生成' });
        }
        // 先到的任务失败/取消，或它生成后提示词又被改过：用本批的提示词再提交一次
        continue;
      }
      Assets.update(asset.id, { status: prevImage ? 'done' : 'failed', error: e.message });
      throw e;
    }
  }
  if (!outputs) { restoreAsset('资产生成未完成'); throw new Error('资产生成未完成'); }
  const img = pickOutput(outputs, 'images');
  if (!img) { restoreAsset('文生图工作流未返回图片'); throw new Error('文生图工作流未返回图片'); }
  const ext = path.extname(img.filename) || '.png';
  const relDir = 'assets/' + PROJECT_ASSET_SUBDIRS[asset.category] + '/';
  const relPath = relDir + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, prompt_used: prompt, negative_prompt, status: 'done', error: '' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath });
}

// 复用：以参考图跑 Qwen-Image-Edit 图生图，返回产物 { img, ext }（调用方负责下载落盘）
async function runI2iEdit(ctx, { refAbs, prompt, namePrefix, seed, dedupeKey }) {
  const refName = await uploadTaskInput(ctx.cfg, refAbs, 'ic_ref_' + ctx.projectId.slice(0, 8) + '_' + uid().slice(0, 8) + path.extname(refAbs));
  const spec = getSpecForKind(ctx.cfg, 'i2i');
  const prefix = namePrefix || ('assets/edit_' + uid().slice(0, 8));
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    positive_prompt: prompt, image: refName, seed: seed ?? randomSeed(), filename_prefix: prefix,
  }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, dedupeKey, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const img = pickOutput(outputs, 'images');
  if (!img) throw new Error('图生图工作流未返回图片');
  return { img, ext: path.extname(img.filename) || '.png' };
}

async function hEditAssetImage(ctx, args) {
  const asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  let refAbs;
  if (args.reference_image_path) {
    refAbs = resolveProjectPath(ctx.projectId, args.reference_image_path);
  } else {
    const refAsset = args.reference_asset_id ? Assets.get(args.reference_asset_id) : asset;
    // 参考资产必须属于本项目：跨项目 id 在下面按本项目路径解析，会指向本项目里的同名相对路径
    // （两个项目的 assets/character/xxx.png 都可能存在），等于拿错图当参考。
    if (!refAsset || refAsset.project_id !== ctx.projectId) throw new Error('参考资产不存在');
    refAbs = resolveProjectPath(ctx.projectId, refAsset.image_path);
  }
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考图不存在，请先生成/上传参考图');
  const fb = assetFallback(asset, ctx.project);
  // 资产自身的提示词优先（用户编辑过 / LLM 阶段写过的，都应盖过调用方这次的临时 prompt），args.prompt 仅作兜底
  const prompt = asset.prompt || args.prompt || fb.prompt;
  ctx.report({ phase: '资产生成', detail: '图生图：' + asset.name });
  const { img, ext } = await runI2iEdit(ctx, { refAbs, prompt, namePrefix: 'assets/' + slugify(asset.name) + '_edit_' + uid().slice(0, 8), dedupeKey: 'asset:' + asset.id });
  const relDir = 'assets/' + PROJECT_ASSET_SUBDIRS[asset.category] + '/';
  const relPath = relDir + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  // 追加版本，仍以最新为准
  const versions = [...(asset.versions || []), asset.image_path].filter(Boolean);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, prompt_used: prompt, versions, status: 'done', error: '' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath });
}

// 变体（换装 / 年龄）是否可以直接复用已有图。
// 复用条件必须包含「内容与提示词都没被改过」：用户可能在前端把变体的提示词改了并保存，
// 这时 prompt ≠ prompt_used —— 直接复用旧图等于把用户的修改吞掉（就是「改了提示词不生效」）。
export function variantReusable(existing, description, explicitPrompt) {
  if (!existing || !existing.image_path || existing.status !== 'done') return false;
  if (String(existing.description || '') !== String(description || '')) return false;
  if (String(existing.prompt || '') !== String(existing.prompt_used || '')) return false;
  if (explicitPrompt != null && String(existing.prompt || '') !== String(explicitPrompt)) return false;
  return true;
}

// 变体出图用的提示词：调用方显式给的 > 资产里被改过的（用户手改的优先）> 兜底/视觉精修。
// 注意「被改过」= prompt ≠ prompt_used：只有这时资产自身的提示词才代表用户的新指令。
export function variantPrompt(existing, explicitPrompt, fallback) {
  if (explicitPrompt != null && String(explicitPrompt).trim()) return String(explicitPrompt);
  const own = String((existing && existing.prompt) || '').trim();
  if (own && own !== String((existing && existing.prompt_used) || '')) return own;
  return fallback;
}

// 自动生成的 BGM 回写「背景音乐库」：同名资产复用（原地更新），否则每次重新生成都会新增一条
// 同名资产——音乐库堆重复条目，audios 按名字映射时指向哪一条还取决于列表顺序。
export function upsertMusicAsset(ctx, name, patch) {
  const dup = Assets.list(ctx.projectId, 'music').find((a) => a.name === name);
  const asset = dup || Assets.create(ctx.projectId, { category: 'music', name });
  Assets.update(asset.id, patch);
  return asset.id;
}

async function hChangeOutfit(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('change_outfit 只能对角色（character）资产使用');
  const refAbs = resolveProjectPath(ctx.projectId, char.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('角色参考图不存在，请先生成/上传角色 canonical 图');
  const outfit = String(args.outfit || '').trim();
  if (!outfit) throw new Error('请提供 outfit（服装描述）');
  const label = String(args.label || '').trim();
  const name = char.name + '-' + (label || outfit);
  // 同名变体（不限状态）：内容/提示词改过就原地重做——既不新建重复资产，也不复用旧图吞掉修改。
  const existing = Assets.list(ctx.projectId, 'costume').find((a) => a.parent_id === char.id && a.name === name);
  if (variantReusable(existing, outfit, args.prompt)) {
    return JSON.stringify({ costume_id: existing.id, image_path: existing.image_path, parent_id: existing.parent_id, reused: true });
  }

  let prompt = variantPrompt(existing, args.prompt, '');
  if (!prompt) {
    const base = 'Keep the character identity, face, hairstyle, expression and art style exactly the same as the reference image; change only the clothing to: ' + outfit + '. Keep the pose and background unchanged.';
    // 视觉精修只要求「开了 vision 且配了 Base URL」：本地无鉴权的多模态端点（llama.cpp 等）
    // 本来就没有 api_key，卡 apiKey 会让这些用户的视觉精修永远静默降级。
    if (!ctx.llmDisabled && visionEnabled(ctx) && ctx.cfg.llm?.baseUrl) {
      try {
        const img = imageToDataUrl(refAbs);
        const dataUrls = img ? ['data:' + img.mimeType + ';base64,' + img.data] : [];
        const r = await llmChat(ctx.cfg.llm, [
          { role: 'system', content: '你是图生图（Qwen-Image-Edit）换装提示词专家。基于参考图与服装描述，输出一段英文编辑指令：保持角色身份/脸部/发型/画风一致，只更换服装；不要输出任何解释，只输出指令文本。' },
          buildVisionUserMessage('参考图如下。请为以下服装写英文图生图换装指令：' + outfit, dataUrls),
        ], { temperature: 0.5, maxTokens: 400 });
        prompt = (r.content || '').trim() || base;
      } catch (e) { logger.warn('换装视觉精修失败，用默认指令', { error: e.message }); prompt = base; }
    } else {
      prompt = base;
    }
  }

  ctx.report({ phase: '人物换装', detail: '为 ' + char.name + ' 生成服装「' + outfit + '」（图生图）' });
  const { img, ext } = await runI2iEdit(ctx, { refAbs, prompt, namePrefix: 'assets/costume_' + slugify(char.name) + '_' + uid().slice(0, 8), dedupeKey: 'outfit:' + char.id });
  const relPath = 'assets/' + PROJECT_ASSET_SUBDIRS.costume + '/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  const costume = existing || Assets.create(ctx.projectId, { category: 'costume', name, description: outfit, prompt, parent_id: char.id });
  // prompt_used 必须落库（= 本次真正用于出图的提示词）：批量/阶段判定「提示词是否改过」全靠它。
  Assets.update(costume.id, { image_path: relPath, source: 'generated', description: outfit, prompt, prompt_used: prompt, status: 'done', error: '' });
  return JSON.stringify({ costume_id: costume.id, image_path: relPath, parent_id: char.id, prompt });
}

// 一次性给角色设计并生成多套服装（衣橱）：复用 change_outfit 的图生图换装，逐套生成服装资产
async function hDesignOutfits(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('design_outfits 只能对角色（character）资产使用');
  const outfits = Array.isArray(args.outfits) ? args.outfits : [];
  if (!outfits.length) throw new Error('请提供 outfits（该角色的多套服装清单）');
  // 依赖判定：服装变体是图生图，必须等父角色的 canonical 图完成，否则每一套都会失败。
  if (!(char.status === 'done' && char.image_path && fs.existsSync(resolveProjectPath(ctx.projectId, char.image_path)))) {
    return JSON.stringify({
      character_id: char.id, character_name: char.name,
      costumes: outfits.map((o) => ({ name: String((o && o.name) || ''), deferred: true })),
      note: '父角色 canonical 图尚未生成完成，服装变体暂缓：请先生成该角色图片',
    });
  }
  // 并发提交：真正限流的是 runWorkflow 的渲染槽位（RunningHub 按 runninghubConcurrency，
  // 本地 ComfyUI 恒为 1），这里一次性把整套服装排进队列即可。
  const results = await Promise.all(outfits.map(async (o) => {
    const name = String((o && o.name) || '').trim();
    const description = String((o && o.description) || name || '').trim();
    if (!description) return null;
    try {
      const r = await hChangeOutfit(ctx, { character_id: char.id, outfit: description, label: name });
      return { name: name || description, ...JSON.parse(r) };
    } catch (e) {
      logger.warn('design_outfits 单套生成失败：' + (name || description), { error: e.message });
      return { name: name || description, error: e.message };
    }
  }));
  const list = results.filter(Boolean);
  const okCount = list.filter((r) => !r.error).length;
  ctx.report({ phase: '人物换装', detail: '为 ' + char.name + ' 设计衣橱：生成 ' + okCount + '/' + outfits.length + ' 套服装' });
  return JSON.stringify({ character_id: char.id, character_name: char.name, costumes: list });
}

// 人物年龄变体：复用换装的图生图一致性思路，只把「换服装」改成「改年龄」。
// 产出 category=age、parent_id 指向角色，供回忆/时间跳跃镜头按章引用。
async function hChangeAge(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('change_age 只能对角色（character）资产使用');
  const refAbs = resolveProjectPath(ctx.projectId, char.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('角色参考图不存在，请先生成/上传角色 canonical 图');
  const age = String(args.age || '').trim();
  if (!age) throw new Error('请提供 age（年龄/时期描述）');
  const label = String(args.label || '').trim();
  const name = char.name + '-' + (label || age);
  // 同名变体（不限状态）优先；其次按描述精确匹配（避免旧数据命名不一致时重复生成）。
  // 不再用 name.includes(label) 这种模糊匹配 —— 它可能命中另一个变体，把改过的内容静默跳过。
  const ages = Assets.list(ctx.projectId, 'age').filter((a) => a.parent_id === char.id);
  const existing = ages.find((a) => a.name === name) || ages.find((a) => String(a.description || '') === age);
  if (variantReusable(existing, age, args.prompt)) {
    return JSON.stringify({ age_id: existing.id, image_path: existing.image_path, parent_id: existing.parent_id, reused: true });
  }

  let prompt = variantPrompt(existing, args.prompt, '');
  if (!prompt) {
    const base = 'Keep the character identity, face (facial features), hairstyle and art style exactly the same as the reference image; change only the age/appearance to: ' + age + '. Keep the pose and outfit unchanged.';
    // 视觉精修只要求「开了 vision 且配了 Base URL」：本地无鉴权的多模态端点（llama.cpp 等）
    // 本来就没有 api_key，卡 apiKey 会让这些用户的视觉精修永远静默降级。
    if (!ctx.llmDisabled && visionEnabled(ctx) && ctx.cfg.llm?.baseUrl) {
      try {
        const img = imageToDataUrl(refAbs);
        const dataUrls = img ? ['data:' + img.mimeType + ';base64,' + img.data] : [];
        const r = await llmChat(ctx.cfg.llm, [
          { role: 'system', content: '你是图生图（Qwen-Image-Edit）年龄变体提示词专家。基于参考图与年龄描述，输出一段英文编辑指令：保持角色身份/脸部/五官/发型/画风一致，只改年龄；不要输出任何解释，只输出指令文本。' },
          buildVisionUserMessage('参考图如下。请为以下年龄/时期写英文图生图变体指令：' + age, dataUrls),
        ], { temperature: 0.5, maxTokens: 400 });
        prompt = (r.content || '').trim() || base;
      } catch (e) { logger.warn('年龄变体视觉精修失败，用默认指令', { error: e.message }); prompt = base; }
    } else {
      prompt = base;
    }
  }

  ctx.report({ phase: '人物年龄', detail: '为 ' + char.name + ' 生成年龄变体「' + age + '」（图生图）' });
  const { img, ext } = await runI2iEdit(ctx, { refAbs, prompt, namePrefix: 'assets/age_' + slugify(char.name) + '_' + uid().slice(0, 8), dedupeKey: 'age:' + char.id });
  const relPath = 'assets/' + PROJECT_ASSET_SUBDIRS.age + '/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  const ageAsset = existing || Assets.create(ctx.projectId, { category: 'age', name, description: age, prompt, parent_id: char.id });
  Assets.update(ageAsset.id, { image_path: relPath, source: 'generated', description: age, prompt, prompt_used: prompt, status: 'done', error: '' });
  return JSON.stringify({ age_id: ageAsset.id, image_path: relPath, parent_id: char.id, prompt });
}

// 一次性给角色设计并生成多个时期/年龄变体：复用 change_age 的图生图变体，逐时期生成 age 资产
async function hDesignAges(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('design_ages 只能对角色（character）资产使用');
  const ages = Array.isArray(args.ages) ? args.ages : [];
  if (!ages.length) throw new Error('请提供 ages（该角色的多时期清单）');
  // 依赖判定：年龄变体同为图生图，必须等父角色 canonical 图完成。
  if (!(char.status === 'done' && char.image_path && fs.existsSync(resolveProjectPath(ctx.projectId, char.image_path)))) {
    return JSON.stringify({
      character_id: char.id, character_name: char.name,
      ages: ages.map((o) => ({ name: String((o && o.name) || ''), deferred: true })),
      note: '父角色 canonical 图尚未生成完成，年龄变体暂缓：请先生成该角色图片',
    });
  }
  const results = await Promise.all(ages.map(async (o) => {
    const name = String((o && o.name) || '').trim();
    const description = String((o && o.description) || name || '').trim();
    if (!description) return null;
    try {
      const r = await hChangeAge(ctx, { character_id: char.id, age: description, label: name });
      return { name: name || description, ...JSON.parse(r) };
    } catch (e) {
      logger.warn('design_ages 单时期生成失败：' + (name || description), { error: e.message });
      return { name: name || description, error: e.message };
    }
  }));
  const list = results.filter(Boolean);
  const okCount = list.filter((r) => !r.error).length;
  ctx.report({ phase: '人物年龄', detail: '为 ' + char.name + ' 设计年龄变体：生成 ' + okCount + '/' + ages.length + ' 个时期' });
  return JSON.stringify({ character_id: char.id, character_name: char.name, ages: list });
}

async function hViewAsset(ctx, args) {
  const a = Assets.get(args.asset_id);
  if (!a || a.project_id !== ctx.projectId) throw new Error('资产不存在');
  const text = JSON.stringify({ id: a.id, category: a.category, name: a.name, description: a.description, prompt: a.prompt || '', prompt_used: a.prompt_used || '', prompt_locked: a.prompt_locked ? 1 : 0, negative_prompt: a.negative_prompt || '', image_path: a.image_path, voice_desc: a.voice_desc || '', parent_id: a.parent_id || '', status: a.status });
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本描述）';
  const abs = resolveProjectPath(ctx.projectId, a.image_path);
  const images = imagesFromPaths([abs], 1);
  return images.length ? { text, images } : text + '（该资产暂无参考图）';
}

async function hViewShotReferences(ctx, args) {
  const shot = Shots.get(args.shot_id);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const assets = Assets.list(ctx.projectId);
  const byId = (id) => assets.find((x) => x.id === id);
  const chars = (shot.character_ids || []).map(byId).filter(Boolean);
  const scenes = (shot.scene_ids || []).map(byId).filter(Boolean);
  const props = (shot.prop_ids || []).map(byId).filter(Boolean);
  const costumes = (shot.costume_ids || []).map(byId).filter(Boolean);
  const audios = (shot.audio_ids || []).map(byId).filter(Boolean);
  const text = JSON.stringify({
    characters: chars.map((c) => ({ id: c.id, name: c.name, image_path: c.image_path })),
    scenes: scenes.map((s) => ({ id: s.id, name: s.name, image_path: s.image_path })),
    props: props.map((p) => ({ id: p.id, name: p.name, image_path: p.image_path })),
    costumes: costumes.map((c) => ({ id: c.id, name: c.name, image_path: c.image_path, parent_id: c.parent_id || '' })),
    audios: audios.map((a) => ({ id: a.id, name: a.name, category: a.category, audio_path: a.audio_path || a.voice_ref })),
  });
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本清单）';
  const absPaths = [...chars, ...scenes, ...props, ...costumes].map((x) => resolveProjectPath(ctx.projectId, x.image_path)).filter(Boolean);
  const images = imagesFromPaths(absPaths, 6);
  return images.length ? { text, images } : text + '（该分镜暂无参考图）';
}

// 解析目标章节 id 集合：ctx.chapter 可能是标题或 id；无目标（全部章节）返回 null。
export function targetChapterIdSet(ctx) {
  if (!ctx.chapter) return null;
  const set = new Set();
  for (const c of Chapters.list(ctx.projectId)) {
    if (c.title === ctx.chapter || c.id === ctx.chapter) set.add(c.id);
  }
  return set;
}

async function hViewProjectReferences(ctx) {
  const refs = filterReferenceImages(ReferenceImages.list(ctx.projectId, { mode: 'reference' }), targetChapterIdSet(ctx));
  const text = JSON.stringify(refs.map((r) => ({ id: r.id, chapter_id: r.chapter_id || '', name: r.name, image_path: r.image_path, category: r.category, description: r.description || '' })));
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本清单）';
  const absPaths = refs.map((r) => resolveProjectPath(ctx.projectId, r.image_path)).filter(Boolean);
  const images = imagesFromPaths(absPaths, 6);
  return images.length ? { text, images } : text + '（暂无参考图）';
}

async function hWebSearch(ctx, args) {
  // 设置里关闭联网搜索时，两个工具都返回 disabled（不抛错），让 Agent 用既有知识继续、不要重试。
  if (ctx.cfg.search?.enabled === false) {
    return JSON.stringify({ disabled: true, message: '联网搜索已在设置中关闭。请改用你的既有知识继续，不要重试。' });
  }
  if (args.type === 'image') {
    return JSON.stringify(await searchImages(args.query, { limit: args.limit }));
  }
  return JSON.stringify(await searchWeb(args.query, { limit: args.limit, engine: args.engine }));
}

async function hDownloadReferenceImage(ctx, args) {
  if (ctx.cfg.search?.enabled === false) {
    return JSON.stringify({ disabled: true, message: '联网搜索已在设置中关闭，无法下载参考图。' });
  }
  const url = String(args.url || '').trim();
  if (!url) throw new Error('请提供图片 URL');
  const { buffer, ext } = await downloadImageSafe(url);
  // 参考图必须归属某章（references 上传链路要求 chapter_id 必填）；优先当前目标章节，否则第一章。
  const chapters = Chapters.list(ctx.projectId);
  if (!chapters.length) throw new Error('项目还没有章节，无法登记参考图');
  const chapterId = (chapters.find((c) => c.title === ctx.chapter || c.id === ctx.chapter) || chapters[0]).id;
  const category = ASSET_CATEGORY_IDS.includes(args.category) ? args.category : 'prop';
  let baseName = String(args.name || '').trim();
  if (!baseName) {
    try {
      const p = new URL(url).pathname;
      const b = path.basename(p, path.extname(p));
      if (b) baseName = decodeURIComponent(b).slice(0, 40);
    } catch { /* 用兜底名 */ }
  }
  const name = (baseName || '下载参考图').trim();
  const relPath = 'references/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  const abs = resolveProjectPath(ctx.projectId, relPath);
  if (!abs) throw new Error('非法保存路径');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const ref = ReferenceImages.create(ctx.projectId, {
    chapter_id: chapterId,
    name,
    image_path: relPath,
    mode: 'reference',
    category,
    description: String(args.description || '').trim(),
    origin: 'downloaded',
  });
  ctx.report({ phase: '下载参考图', detail: '已下载并登记参考图：' + name });
  return JSON.stringify({ reference_id: ref.id, name: ref.name, image_path: relPath, category });
}

async function hGenerateAssetFromReference(ctx, args) {
  const ref = ReferenceImages.get(args.reference_id);
  if (!ref || ref.project_id !== ctx.projectId) throw new Error('参考素材不存在');
  const category = args.category || 'other';
  const name = String(args.name || '').trim();
  if (!name) throw new Error('请提供新素材名称 name');
  // 变体（服装/年龄）必须绑角色；非变体传了 parent_id 直接拒绝（见 resolveAssetParent）
  const parentId = resolveAssetParent(ctx, category, args.parent_id);
  const refAbs = resolveProjectPath(ctx.projectId, ref.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考图不存在，请先上传参考图');
  const asset = Assets.create(ctx.projectId, { category, name, description: args.description || '', parent_id: parentId });
  const fb = fallbackAssetPrompt({ type: category, name, description: args.description || '', style: ctx.project.style });
  const prompt = args.prompt || fb.prompt;
  ctx.report({ phase: '资产生成', detail: '参考图生成新素材：' + name });
  const { img, ext } = await runI2iEdit(ctx, { refAbs, prompt, namePrefix: 'assets/' + slugify(name) + '_ref_' + uid().slice(0, 8), dedupeKey: 'ref-asset:' + asset.id });
  const relDir = 'assets/' + (PROJECT_ASSET_SUBDIRS[category] || 'other') + '/';
  const relPath = relDir + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, prompt_used: prompt, status: 'done', error: '' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath, reference_id: ref.id });
}

async function hRegisterVoice(ctx, args) {
  const a = Assets.get(args.asset_id);
  if (!a || a.project_id !== ctx.projectId) throw new Error('资产不存在');
  // 手填/上传的参考语音同样标记「声音限制已用」，避免音色阶段重复重做
  Assets.update(args.asset_id, { voice_ref: args.voice_ref, voice_desc_used: a.voice_desc || '' });
  return '已登记参考语音';
}

async function hDesignVoice(ctx, args) {
  let asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  const dedupeKey = 'voice:' + asset.id;
  if (Queue.activeByDedupe(dedupeKey)) {
    if (!(await waitForActiveRender(dedupeKey, ctx.isAborted))) throw new Error('等待其他任务完成该角色音色超时');
    asset = Assets.get(asset.id) || asset;
    let exists = false;
    try { exists = !!(asset.voice_ref && fs.existsSync(resolveProjectPath(ctx.projectId, asset.voice_ref))); } catch {}
    if (exists && (asset.voice_desc_used || '') === (asset.voice_desc || '')) {
      return JSON.stringify({ asset_id: asset.id, skipped: true, reason: '其他任务已完成该角色音色' });
    }
  }
  // 朗读文案：优先显式传入；其次从声音画像取；绝不用「外貌描述」当朗读文案（那是给文生图的）。
  // 都缺时给通用自我介绍模板，避免批量阶段念出一段外貌描写。
  const MAX_TTS_TEXT = 30;
  let text = (args.text || '').trim();
  if (!text) text = (asset.voice_desc || '').trim() || ('你好，我是' + asset.name + '。很高兴认识你。');
  if (text.length > MAX_TTS_TEXT) {
    logger.warn('音色设计朗读文案过长（' + text.length + ' 字），已截断到 ' + MAX_TTS_TEXT + ' 字：' + asset.name);
    text = text.slice(0, MAX_TTS_TEXT);
  }
  // 音色描述：显式传入（含空串=用户想清空） > 资产声音画像(voice_desc) > 从名称/描述推断性别年龄 > 中性兜底。
  // 必须让性别/年龄显式进入 voice_description——缺失时 Qwen3-TTS 自由发挥，男主会变女声。
  const hasExplicitVoiceDesc = Object.prototype.hasOwnProperty.call(args, 'voice_description');
  const rawVoiceDesc = hasExplicitVoiceDesc ? (args.voice_description || '').trim() : '';
  const voice_description = rawVoiceDesc
    || (asset.voice_desc || '').trim()
    || inferVoiceBaseline(asset.name, asset.description)
    || '自然清晰的中性嗓音，无明显性别特征';
  // 若用户显式传了空串（想清空），用默认兜底且后续把 asset.voice_desc 设为空
  const explicitEmpty = hasExplicitVoiceDesc && rawVoiceDesc === '';
  if (!rawVoiceDesc && !(asset.voice_desc || '').trim()) {
    logger.warn('音色描述使用推断兜底（资产缺 voice_desc）：' + asset.name + ' → ' + voice_description);
  }
  const spec = getSpecForKind(ctx.cfg, 'tts');
  const prefix = 'voice/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  const prevRef = asset.voice_ref || asset.audio_path || '';
  ctx.report({ phase: '音色设计', detail: '设计音色：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  try {
    const { outputs } = await runWorkflow(ctx.cfg, spec, {
      text, voice_description, seed: randomSeed(), filename_prefix: prefix,
    }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: '', subject: asset.name || asset.id, dedupeKey: 'voice:' + asset.id, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const aud = pickOutput(outputs, 'audio');
    if (!aud) throw new Error('音色设计工作流未返回音频');
    const ext = path.extname(aud.filename) || '.wav';
    const relPath = 'assets/voice/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, aud, relPath);
    // 若用户显式传了空串（想清空），把 asset.voice_desc 设为空；否则写入生成时用的 voice_description
    const savedVoiceDesc = explicitEmpty ? '' : voice_description;
    Assets.update(asset.id, { voice_ref: relPath, audio_path: relPath, source: 'generated', status: 'done', voice_desc: savedVoiceDesc, voice_desc_used: voice_description, error: '' });
    return JSON.stringify({ asset_id: asset.id, voice_ref: relPath });
  } catch (e) {
    Assets.update(asset.id, { status: prevRef ? 'done' : 'failed', error: e.message });
    throw e;
  }
}

// 按工作流分批统一生成：① 文生图全部图片资产 → ② Qwen3-TTS 全部人物音色（同一工作流连续跑完再切下一类，省模型加载）
// only 缺省时图+音色一起跑（Agent 原有行为不变）；传 only 可只跑其中一类，
// 供阶段调度把「资产图」和「音色」拆到不同的 ComfyUI 实例（CK 开关要求不同）
async function hGenerateAssetsBatch(ctx, args) {
  const only = args && Array.isArray(args.only) ? args.only : null;
  // 值域与工具 schema 的 enum 一致：只有 image / tts 两类。写错（如 ['video']）时
  // 会两类都不跑，却回报一条「全部完成、0 失败」的成功结果，阶段调度据此以为已经做完了。
  if (only) {
    const bad = only.filter((k) => k !== 'image' && k !== 'tts');
    if (bad.length) throw new Error('only 只能是 image / tts（收到：' + bad.join('、') + '）');
  }
  const wantImage = !only || only.includes('image');
  const wantVoice = !only || only.includes('tts');
  const assets = Assets.list(ctx.projectId);
  const imageAssets = assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category));
  const charAssets = assets.filter((a) => a.category === 'character');
  const res = { images: { total: 0, generated: 0, failed: 0 }, voices: { total: 0, generated: 0, failed: 0, skipped: 0 } };

  if (wantImage) {
    // 并发提交：真正限流的是 runWorkflow 里的渲染槽位（RunningHub 按 runninghubConcurrency，
    // 本地 ComfyUI 恒为 1），这里把整批一次性排进队列即可。
    // 跳过「已生成且提示词未变过」的资产；用户若改过 prompt（与上次生成用的 prompt_used 不同）则重新生成。
    const pending = imageAssets.filter((a) => !(a.image_path && a.status === 'done' && (a.prompt_used || '') === (a.prompt || '')));
    ctx.report({ phase: '资产生成', detail: '第1批·文生图：' + pending.length + ' 个图片资产（并发 ' + renderConcurrencyLimit(ctx.cfg) + '）' });
    await Promise.all(pending.map(async (a) => {
      if (ctx.isAborted && ctx.isAborted()) return;
      res.images.total++;
      try { await hGenerateAssetImage(ctx, { asset_id: a.id }); res.images.generated++; }
      catch (e) {
        if (ctx.isAborted && ctx.isAborted()) return;
        res.images.failed++; Assets.update(a.id, { status: 'failed', error: e.message }); ctx.report({ phase: '资产生成', detail: '图片失败 ' + a.name + '：' + e.message });
      }
    }));
    if (ctx.isAborted && ctx.isAborted()) return JSON.stringify({ ...res, aborted: true });
  }

  if (wantVoice) {
    // 音色同样按渲染槽位并发；跳过逻辑与串行版本一致。
    ctx.report({ phase: '音色设计', detail: '第2批·音色设计：' + charAssets.length + ' 个角色音色（并发 ' + renderConcurrencyLimit(ctx.cfg) + '）' });
    await Promise.all(charAssets.map(async (a) => {
      if (ctx.isAborted && ctx.isAborted()) return;
      // 跳过「已有音色且声音限制未变过」的角色；用户改过 voice_desc（与上次用的 voice_desc_used 不同）则重做
      if (a.voice_ref && fs.existsSync(resolveProjectPath(ctx.projectId, a.voice_ref)) && (a.voice_desc_used || '') === (a.voice_desc || '')) return;
      // 无声音画像且无法从名称/描述推断性别年龄 → 跳过并提示，不静默出性别错乱的音色
      const base = inferVoiceBaseline(a.name, a.description);
      if (!(a.voice_desc || '').trim() && !base) {
        res.voices.skipped++;
        ctx.report({ phase: '音色设计', detail: '跳过 ' + a.name + '：资产无声音特征描述（voice_desc），无法推断性别/年龄。请先在 LLM 阶段调用 create_asset/update_asset 补充 voice_desc 或用 design_voice 为其设计音色。' });
        return;
      }
      res.voices.total++;
      try { await hDesignVoice(ctx, { asset_id: a.id }); res.voices.generated++; }
      catch (e) {
        if (ctx.isAborted && ctx.isAborted()) return;
        res.voices.failed++; Assets.update(a.id, { status: 'failed', error: e.message }); ctx.report({ phase: '音色设计', detail: '音色失败 ' + a.name + '：' + e.message });
      }
    }));
    if (ctx.isAborted && ctx.isAborted()) return JSON.stringify({ ...res, aborted: true });
  }

  return JSON.stringify(res);
}

// —— 换装事件自动识别与服装资产生成（确定性兜底，不依赖 LLM 记忆） ——
// 剧情里的「沐浴/洗澡/更衣/换衣/换装」意味着角色着装状态发生变化（洗澡后理应换干净衣服）。
// 系统据此自动为对应角色生成一套服装资产（change_outfit，图生图保持脸/发型/画风一致），
// 并自动绑定到「换装事件之后」的镜头；事件之前的镜头继续用角色原图或旧服装。
const OUTFIT_BATH_RE = /沐浴|洗澡|浴桶|沐浴更衣/;
const OUTFIT_CHANGE_RE = /更衣|换衣|换装|换衣服|换了衣服|换上了|换上一身|换了一身|换上一套|换了一套|换上新衣|换上新裳|换上新衣裳/;

function detectOutfitChange(text) {
  if (!text) return null;
  const m = String(text).match(OUTFIT_BATH_RE);
  if (m) return { kind: 'bath', keyword: m[0] };
  const c = String(text).match(OUTFIT_CHANGE_RE);
  if (c) return { kind: 'change', keyword: c[0] };
  return null;
}

function inferOutfitDescription(text, kind, keyword) {
  if (kind === 'bath') return '沐浴后换上的干净衣裳';
  if (kind === 'change') {
    const t = String(text);
    const i = t.indexOf(keyword);
    if (i >= 0) {
      let seg = t.slice(i + keyword.length, i + keyword.length + 16);
      seg = seg.replace(/^[的了过，。；：!！?？]+/, '').trim();
      const cut = seg.search(/[，。；：!！?？]/);
      if (cut >= 0) seg = seg.slice(0, cut);
      if (seg.trim()) return seg.trim();
    }
    return '新换的衣裳';
  }
  return '新换的衣裳';
}


// 扫描本次写入分镜所属章节的换装事件，自动生成服装资产并绑定到事件之后的镜头。
// 幂等：同名服装已存在则复用（change_outfit 内部去重）；生成失败不阻塞分镜写入（该镜继续用角色原图兜底）。
async function autoResolveOutfits(ctx, chapters) {
  const chapterSet = new Set((chapters || []).filter(Boolean).map(String));
  if (!chapterSet.size) return { generated: 0, bound: 0, notes: [] };
  const shots = Shots.list(ctx.projectId)
    .filter((s) => chapterSet.has(String(s.chapter || '')))
    .sort((a, b) => String(a.chapter || '').localeCompare(String(b.chapter || ''), 'zh') || (a.idx - b.idx));
  if (!shots.length) return { generated: 0, bound: 0, notes: [] };

  // 本阶段禁止渲染（LLM 创作阶段）时只检测、不生成：兜底要图生图出图，而那个阶段的硬约束是不碰
  // ComfyUI（见 runTool 对 RENDER_TOOLS 的拦截、agent-loop 系统提示「这些工具只会返回已跳过」）。
  // 原先 set_storyboard 直接调 hChangeOutfit，绕过了这层拦截：LLM 阶段照跑一次渲染，ComfyUI 没启动
  // 时会白等一次超时。生成改由「资产图」阶段执行（stages.js RENDER_STAGE_TOOLS.image →
  // resolveShotProvisions），那里才有 ComfyUI。这里把待兜底镜头数回报出去，免得静默消失。
  if (ctx.renderDisabled) {
    const pending = shots.filter((s) => detectOutfitChange([s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' '))).length;
    return { generated: 0, bound: 0, notes: [], deferred: pending };
  }

  const assets = Assets.list(ctx.projectId);
  const byId = {};
  const charById = {};
  for (const a of assets) { byId[a.id] = a; if (a.category === 'character') charById[a.id] = a; }

  const currentCostume = {};   // charId -> costumeId（本章内当前着装）
  let prevChapter = null;
  let generated = 0, bound = 0;
  const notes = [];
  const textOf = (s) => [s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' ');

  for (const s of shots) {
    // 用户已停止：不再往下识别/生成换装变体。每个事件都会真的提交一次图生图，
    // 停止之后继续跑等于白烧 GPU（已提交的项目会排在 ComfyUI 队列里被挨个执行）。
    if (ctx.isAborted && ctx.isAborted()) break;
    // 章节边界：重置「当前着装」状态（换装跟随剧情在同一章内连续）
    if (prevChapter !== null && s.chapter !== prevChapter) { for (const k of Object.keys(currentCostume)) delete currentCostume[k]; }
    prevChapter = s.chapter;

    const charIds = (s.character_ids || []).filter((id) => charById[id]);
    const charNames = charIds.map((id) => charById[id] && charById[id].name).filter(Boolean);
    const text = textOf(s);
    const costumeIds = new Set(s.costume_ids || []);

    // 已显式引用服装的角色（LLM 在 costumes 字段里绑定了服装资产）跳过自动兜底，避免重复生成。
    // 判定必须只看「库里已有的绑定」，即必须在并入 currentCostume 之前算：
    // currentCostume 是本函数刚刚自动生成/绑定出来的结果，把它一起算进去的话，同一章里
    // 第二次换装事件会被当成「已显式引用」直接 continue —— 服装只换一次，之后永不更新。
    const charHasCostume = {};
    for (const costumeId of costumeIds) { const a = byId[costumeId]; if (a && a.parent_id) charHasCostume[a.parent_id] = true; }

    // 1) 再应用当前着装到本镜（若此前已发生换装）
    for (const cid of charIds) if (currentCostume[cid]) costumeIds.add(currentCostume[cid]);

    // 2) 检测本镜是否发生换装事件，归属到具体角色并生成服装资产（自下一镜起生效）
    const evt = detectOutfitChange(text);
    if (evt) {
      for (const cid of charIds) {
        if (charHasCostume[cid]) continue;
        const char = charById[cid];
        // 归属判定用 textMentions：文本里「小明」提到的是「小明」，不是同场的短名「明」
        //（旧写法 text.includes(char.name) 会给「明」也错生成一套服装，并写进本镜 costume_ids）
        const named = charIds.length === 1 || textMentions(text, char.name, charNames);
        if (!named) continue;
        const outfit = inferOutfitDescription(text, evt.kind, evt.keyword);
        try {
          const r = await hChangeOutfit(ctx, { character_id: cid, outfit });
          const info = JSON.parse(r);
          currentCostume[cid] = info.costume_id;
          generated++;
          notes.push('自动换装：' + char.name + ' → ' + outfit);
        } catch (e) {
          logger.warn('自动换装失败：' + char.name + '（' + outfit + '）', { error: e.message });
          notes.push('自动换装失败：' + char.name + '（' + e.message + '）');
        }
      }
    }

    // 3) 写回本镜 costume_ids（含新生成/复用的服装）
    const existing = [...(s.costume_ids || [])].sort();
    const next = [...costumeIds].sort();
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      Shots.update(s.id, { costume_ids: next });
      bound++;
    }
  }
  return { generated, bound, notes };
}

// —— 年龄变化事件自动识别与年龄变体资产生成（确定性兜底，不依赖 LLM 记忆） ——
// 剧情里的「回忆/年轻时/N年前/多年后/步入中年/步入老年」意味着角色年龄状态发生变化。
// 系统据此以角色 canonical 图为参考自动生成年龄变体（change_age，图生图保持身份一致、只改年龄），
// 并绑定到「时间跳跃之后」的镜头；事件之前的镜头继续用角色原图（或旧年龄变体）。
const AGE_OLD_RE = /老年|年老|老了|变老|步入老年|白发|苍老/;
const AGE_MID_RE = /中年|步入中年/;
const AGE_YOUNG_RE = /年轻|少年|年少|小时候|童年|幼年|当年|从前|过去|往事|回忆|想起|\d+\s*年前|时光|岁月/;
const AGE_OLDER_RE = /长大|成年|\d+\s*年后/;

function detectAgeChange(text) {
  if (!text) return null;
  const t = String(text);
  let m = t.match(AGE_OLD_RE); if (m) return { keyword: m[0], variant: { label: '老年', age: '老年时的样貌' } };
  m = t.match(AGE_MID_RE); if (m) return { keyword: m[0], variant: { label: '中年', age: '中年时的样貌' } };
  m = t.match(AGE_YOUNG_RE); if (m) return { keyword: m[0], variant: { label: '年轻', age: '年轻时的样貌' } };
  m = t.match(AGE_OLDER_RE); if (m) return { keyword: m[0], variant: { label: '更年长', age: '更年长时的样貌' } };
  return null;
}

// 扫描本次写入分镜所属章节的年龄变化事件，自动生成年龄变体并绑定到事件之后的镜头。
// 幂等：同名年龄变体已存在则复用（change_age 内部去重）；生成失败不阻塞分镜写入（该镜继续用角色原图兜底）。
async function autoResolveAges(ctx, chapters) {
  const chapterSet = new Set((chapters || []).filter(Boolean).map(String));
  if (!chapterSet.size) return { generated: 0, bound: 0, notes: [] };
  const shots = Shots.list(ctx.projectId)
    .filter((s) => chapterSet.has(String(s.chapter || '')))
    .sort((a, b) => String(a.chapter || '').localeCompare(String(b.chapter || ''), 'zh') || (a.idx - b.idx));
  if (!shots.length) return { generated: 0, bound: 0, notes: [] };

  // 同 autoResolveOutfits：LLM 阶段（renderDisabled）只检测不生成，生成推迟到「资产图」阶段。
  if (ctx.renderDisabled) {
    const pending = shots.filter((s) => detectAgeChange([s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' '))).length;
    return { generated: 0, bound: 0, notes: [], deferred: pending };
  }

  const assets = Assets.list(ctx.projectId);
  const byId = {};
  const charById = {};
  for (const a of assets) { byId[a.id] = a; if (a.category === 'character') charById[a.id] = a; }

  const currentAge = {};   // charId -> ageId（本章内当前年龄）
  let prevChapter = null;
  let generated = 0, bound = 0;
  const notes = [];
  const textOf = (s) => [s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' ');

  for (const s of shots) {
    // 同 autoResolveOutfits：停止后不再继续生成年龄变体（每次都会真提交一次图生图）
    if (ctx.isAborted && ctx.isAborted()) break;
    if (prevChapter !== null && s.chapter !== prevChapter) { for (const k of Object.keys(currentAge)) delete currentAge[k]; }
    prevChapter = s.chapter;

    const charIds = (s.character_ids || []).filter((id) => charById[id]);
    const charNames = charIds.map((id) => charById[id] && charById[id].name).filter(Boolean);
    const text = textOf(s);
    const ageIds = new Set(s.age_ids || []);

    // 已显式引用年龄变体的角色（LLM 在 ages 字段里绑定）跳过自动兜底，避免重复生成。
    // 与服装同理：必须在并入 currentAge 之前判定，否则同一章内第二次时间跳跃会被跳过。
    const charHasAge = {};
    for (const ageId of ageIds) { const a = byId[ageId]; if (a && a.parent_id) charHasAge[a.parent_id] = true; }

    // 1) 再应用当前年龄到本镜（若此前已发生时间跳跃）
    for (const cid of charIds) if (currentAge[cid]) ageIds.add(currentAge[cid]);

    // 2) 检测本镜是否发生年龄变化事件，归属到具体角色并生成年龄变体（自下一镜起生效）
    const evt = detectAgeChange(text);
    if (evt) {
      for (const cid of charIds) {
        if (charHasAge[cid]) continue;
        const char = charById[cid];
        // 同 autoResolveOutfits：年龄变体只归属「文本真正提到」的角色（短名不被同场更长名吞掉）
        const named = charIds.length === 1 || textMentions(text, char.name, charNames);
        if (!named) continue;
        try {
          const r = await hChangeAge(ctx, { character_id: cid, age: evt.variant.age, label: evt.variant.label });
          const info = JSON.parse(r);
          currentAge[cid] = info.age_id;
          generated++;
          notes.push('自动年龄变体：' + char.name + ' → ' + evt.variant.age);
        } catch (e) {
          logger.warn('自动年龄变体失败：' + char.name + '（' + evt.variant.age + '）', { error: e.message });
          notes.push('自动年龄变体失败：' + char.name + '（' + e.message + '）');
        }
      }
    }

    // 3) 写回本镜 age_ids（含新生成/复用的年龄变体）
    const existing = [...(s.age_ids || [])].sort();
    const next = [...ageIds].sort();
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      Shots.update(s.id, { age_ids: next });
      bound++;
    }
  }
  return { generated, bound, notes };
}

// set_storyboard 每个分镜只认这些字段，与工具 schema 的 items.properties 一一对应。
// 拼错/传错（visual 写成 sence_name 之外的名字、characters 写成 cast 等）原先会被静默丢弃：
// 分镜照建、内容为空，回报却是「分镜已写入」——模型以为写好了，出片时才发现没有画面/角色。
// 与外部写入 API（shot-write.js 对未声明字段直接 400）同口径：宁可当场报错让模型自纠。
const SHOT_INPUT_KEYS = new Set(['idx', 'chapter', 'scene_name', 'duration', 'characters', 'scenes', 'props', 'costumes', 'ages', 'audios', 'sub_shots', 'dialogue', 'narration', 'camera', 'visual', 'mode']);

// 分镜时长的唯一入口。非数字（模型爱写 "8秒"、"约 10 秒"）必须当场拒绝：静默写成 NaN 会让这条
// 分镜**永远出不了片** —— validateSubShots 里 parseFloat(NaN) || 0 = 0，任何子分镜都判「超过总时长」，
// 重试多少次都一样，而错误信息里只有「超过」两个字，看不出根因在时长上。
// 数字越界仍按原行为夹到 [SHOT_DURATION_MIN, SHOT_DURATION_MAX]。
const durationOf = (sb) => {
  const raw = sb.duration;
  if (raw == null || raw === '') return SHOT_DURATION_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('分镜 duration 必须是数字（秒），当前：' + JSON.stringify(raw));
  return Math.min(SHOT_DURATION_MAX, Math.max(SHOT_DURATION_MIN, n));
};

async function hSetStoryboard(ctx, args) {
  // 字段白名单先于一切：不认的字段一律拒绝，避免「悄悄丢掉内容却回报成功」
  const unknownShotKeys = [];
  const badShots = [];
  (args.shots || []).forEach((sb, i) => {
    // 不是对象的元素必须当场拒绝：后面几轮校验直接按字段取值，遇到 null 会抛 TypeError
    // （"Cannot read properties of null"），模型看不出自己错在哪一条。
    if (!sb || typeof sb !== 'object' || Array.isArray(sb)) { badShots.push('第' + (i + 1) + '条'); return; }
    for (const k of Object.keys(sb)) if (!SHOT_INPUT_KEYS.has(k)) unknownShotKeys.push('第' + (i + 1) + '条.' + k);
  });
  if (badShots.length) {
    throw new Error('分镜必须是对象（每条含 chapter/idx/visual 等字段）：' + badShots.join('、') + ' 不是对象');
  }
  if (unknownShotKeys.length) {
    throw new Error('分镜含未声明字段：' + [...new Set(unknownShotKeys)].join('、') + '。每条分镜只支持：' + [...SHOT_INPUT_KEYS].join('、'));
  }
  // 台词时长校验：中文旁白约 4-5 字/秒，超速会被 H3/TTS 压缩成听不清的模糊声。
  // 硬性拒绝，强制 Agent 缩短台词或拆分镜头，而不是生成后才发现语音对不上。
  const MAX_RATE = SHOT_DIALOGUE_MAX_RATE; // 字/秒（含说话人前缀「醉天：」的余量）
  const over = [];
  for (const sb of args.shots || []) {
    const dur = durationOf(sb);
    const chars = (sb.dialogue || '').length;
    if (chars && chars / dur > MAX_RATE) {
      over.push({ idx: sb.idx, durationSec: dur, dialogueChars: chars, maxChars: Math.floor(dur * MAX_RATE) });
    }
  }
  if (over.length) {
    throw new Error('台词与时长不匹配：中文旁白约 4-5 字/秒，超出会被压缩成听不清的模糊声。请把以下镜头的台词缩短到 maxChars 字以内（或拆成更多镜头 / 延长到最长 15 秒）：' + JSON.stringify(over));
  }
  // 多人对话校验：单分镜最多 MAX_SPEAKERS_PER_SHOT 个说话人；≥3 人对话必须拆成多个分镜，
  // 避免参考音频超限（每说话人一段参考音色）且避免多人同框对话质量下降。
  const multiSpeaker = [];
  for (const sb of args.shots || []) {
    const speakers = dialogueSpeakerNames(sb.dialogue);
    if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
      multiSpeaker.push({ idx: sb.idx, speakers });
    }
  }
  if (multiSpeaker.length) {
    throw new Error('分镜对话人数过多：每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 个说话人，请把多人对话拆成多个分镜（每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 人说话）。涉及分镜：' + JSON.stringify(multiSpeaker));
  }
  // 章节归属先整批解析：分镜是按「章节标题」挂到章节上的（chapter 就是业务键），所以 chapter 必须
  // 是本项目已存在的章节。模型可能传标题、也可能传 id（get_project / list_chapters 同时给出两者），
  // 两个都认。这一步必须在 clear 之前完成：否则一次非法写入会把整章分镜清空后才抛错。
  // 不做这一步的后果：写出「章节视图里看不到、也永远不会被生成」的孤儿分镜，却回报「分镜已写入」。
  const chapterMap = new Map();
  for (const c of Chapters.list(ctx.projectId)) { chapterMap.set(c.title, c.title); chapterMap.set(c.id, c.title); }
  const resolveChapter = (raw) => {
    const want = String(raw == null ? '' : raw).trim() || String(ctx.chapter || '').trim();
    if (!want) throw new Error('分镜缺少 chapter：请传章节标题或 id（可用 list_chapters 查看本项目章节）');
    const title = chapterMap.get(want);
    if (title === undefined) {
      throw new Error('章节不存在：' + want + '（本项目现有章节：' + [...new Set(chapterMap.values())].join('、') + '）');
    }
    return title;
  };
  const shotInputs = args.shots || [];
  const chapterTitles = shotInputs.map((sb) => resolveChapter(sb.chapter));
  const assets = Assets.list(ctx.projectId);
  const byName = (cat) => {
    const m = {};
    for (const a of assets) if (a.category === cat) m[a.name] = a.id;
    return m;
  };
  const charMap = byName('character'); const sceneMap = byName('scene'); const propMap = byName('prop'); const costumeMap = byName('costume'); const ageMap = byName('age');
  // 音频素材跨 voice/music/sfx 三类：统一按名字映射（作为 H3 音色参考）
  const audioMap = {};
  for (const a of assets) if (['voice', 'music', 'sfx'].includes(a.category)) audioMap[a.name] = a.id;
  // clear 只清「本次写入涉及的章节」：原先删的是整个项目的分镜，让「重新生成第2章分镜」把第1章
  // 已出片的镜头一并删掉，还回报「分镜已写入」——看起来完全正常。外部写入 API 的整章写入同口径
  // （app/api/.../storyboard/route.js 只删本章）。其他章节的分镜一律保留。
  const clearTitles = new Set(chapterTitles);
  let existing = Shots.list(ctx.projectId);
  if (args.clear) {
    // 断点续跑防护：clear 会删掉本章分镜（含已渲染的视频）。LLM 阶段重跑时模型若带 clear
    // 重写整章，已花钱出的视频会全部作废，下一次视频阶段又整章重跑。
    // 有成品/正在生成时一律拒绝清空，让模型改用「不带 clear 的 idx upsert」。
    const protectedShots = existing.filter(
      (s) => clearTitles.has(s.chapter) && (s.video_path || s.status === 'done' || s.status === 'generating' || s.status === 'queued'),
    );
    if (protectedShots.length) {
      throw new Error('本章已有 ' + protectedShots.length + ' 个已生成或生成中的分镜，clear 会删除这些成品视频；请去掉 clear，按 idx 更新已有分镜。');
    }
    for (const s of existing) if (clearTitles.has(s.chapter)) Shots.remove(s.id);
    existing = existing.filter((s) => !clearTitles.has(s.chapter));
  }
  // 每章独立 idx 空间：同一 (chapter, idx) 视为同一个镜头，不同章节互不干扰
  const key = (ch, idx) => String(ch || '') + '\u0000' + String(idx);
  const byKey = {}; for (const s of existing) byKey[key(s.chapter, s.idx)] = s;
  const chapterMax = {}; for (const s of existing) chapterMax[s.chapter || ''] = Math.max(chapterMax[s.chapter || ''] || 0, s.idx);
  // 镜号先整批归一（与外部写入 API 的 shot-write.js 同口径：≥1 的整数，章内唯一）：
  // ① 分两遍：先把**全部**显式 idx 计入各章上限，再给省略 idx 的镜头续号。单遍分配时
  //    「自动号在前、显式号在后」会撞号（[无 idx, idx:1] → [1,1]），后一条走 upsert 覆盖前一条，
  //    内容被静默丢掉；
  // ② 越界/非数字在这里拦下，避免 1.5 这类镜号落库后章内序号失去意义。
  for (let i = 0; i < shotInputs.length; i++) {
    const raw = shotInputs[i].idx;
    if (raw == null) continue;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n < 1) throw new Error('分镜 idx 必须是 ≥1 的整数（当前：' + raw + '）');
    const ch = chapterTitles[i];
    chapterMax[ch] = Math.max(chapterMax[ch] || 0, n);
  }
  const idxs = chapterTitles.map((ch, i) => {
    const raw = shotInputs[i].idx;
    if (raw != null) return Math.trunc(Number(raw));
    const n = (chapterMax[ch] || 0) + 1; chapterMax[ch] = n; return n;
  });
  let added = 0, updated = 0;
  // 资产名按名字映射成 id；名字对不上（拼错、资产还没建）原先静默丢弃 —— 分镜照建、参考屏蔽，
  // 回报却是「分镜已写入」。这里收集未命中的名字，随结果一并回报（不拒绝整批：模型可先建资产再回填）。
  const missingRefs = [];
  const idsOf = (names, map, cat) => (names || []).map((n) => {
    const id = map[n];
    if (id === undefined) missingRefs.push(cat + '「' + n + '」');
    return id;
  }).filter(Boolean);
  const touched = [];
  const writtenChapters = new Set();
  for (let i = 0; i < shotInputs.length; i++) {
    const sb = shotInputs[i];
    const ch = chapterTitles[i];
    const idx = idxs[i];
    writtenChapters.add(ch);
    const fields = {
      chapter: ch,
      scene_name: sb.scene_name || ((sb.scenes || []).join('、')),
      camera: sb.camera || '', visual: sb.visual || '', dialogue: sb.dialogue || '', narration: sb.narration || '',
      sub_shots: sb.sub_shots || '', duration: durationOf(sb),
      character_ids: idsOf(sb.characters, charMap, '人物'),
      scene_ids: idsOf(sb.scenes, sceneMap, '场景'),
      prop_ids: idsOf(sb.props, propMap, '道具'),
      costume_ids: idsOf(sb.costumes, costumeMap, '服装'),
      age_ids: idsOf(sb.ages, ageMap, '年龄变体'),
      audio_ids: idsOf(sb.audios, audioMap, '音频'),
      resolution: ctx.project.video_resolution || '480P',
      aspect_ratio: ctx.project.video_aspect_ratio || '16:9',
      mode: sb.mode || '',
    };
    const k = key(ch, idx);
    if (byKey[k] !== undefined) {
      Shots.update(byKey[k].id, fields);
      updated++;
      touched.push({ id: byKey[k].id, idx, reused: true });
    } else {
      const shot = Shots.create(ctx.projectId, { ...fields, idx });
      // 新建的行必须登记回 byKey：否则同一次调用里出现两条 (chapter, idx) 相同的分镜时，
      // 两条都会走 create，落库成「同章同镜号」的重复镜头（注释里承诺的是「视为同一个镜头」）。
      byKey[k] = shot;
      added++;
      touched.push({ id: shot.id, idx: shot.idx });
    }
  }
  // 非破坏：仅新增/更新，绝不自动删除既有分镜（保证旧章节保留，多章节可继续追加）
  // 换装兜底：识别本次写入章节内的沐浴/更衣/换装事件，自动生成服装资产并绑定到事件之后的镜头。
  // 这里用「解析后的章节标题」而不是原始参数：模型传 id 时也要能定位到正确的章节。
  const chapters = [...writtenChapters];
  const outfitRes = await autoResolveOutfits(ctx, chapters);
  if (outfitRes.generated) ctx.report({ phase: '人物换装', detail: '自动识别换装事件，生成服装资产 ' + outfitRes.generated + ' 套' });
  const ageRes = await autoResolveAges(ctx, chapters);
  if (ageRes.generated) ctx.report({ phase: '人物年龄', detail: '自动识别年龄变化事件，生成年龄变体 ' + ageRes.generated + ' 个' });
  let out = '分镜已写入（新增 ' + added + '，更新 ' + updated + '）';
  if (outfitRes.generated) out += '；自动换装生成服装资产 ' + outfitRes.generated + ' 套、绑定 ' + outfitRes.bound + ' 镜';
  if (ageRes.generated) out += '；自动年龄变体生成 ' + ageRes.generated + ' 个、绑定 ' + ageRes.bound + ' 镜';
  // 本阶段不渲染（LLM 创作阶段）时兜底被推迟：把待处理的事件数回报出去，别让模型以为已经处理完
  if (outfitRes.deferred) out += '；检测到 ' + outfitRes.deferred + ' 个换装事件：服装资产将在「资产图」阶段生成并绑定（本阶段不渲染）';
  if (ageRes.deferred) out += '；检测到 ' + ageRes.deferred + ' 个年龄变化：年龄变体将在「资产图」阶段生成并绑定（本阶段不渲染）';
  // 兜底失败原先只写进 notes 且从不使用：服装/年龄变体没生成、镜头继续用原图出片，模型却看不到。
  if (missingRefs.length) out += '；未找到同名资产（已忽略）：' + [...new Set(missingRefs)].join('、') + '。请先创建资产或修正名字';
  const failed = [...(outfitRes.notes || []), ...(ageRes.notes || [])].filter((n) => /失败/.test(n));
  if (failed.length) out += '；' + failed.join('；');
  return out;
}

// 换装/年龄兜底（原先在 set_storyboard 内联执行，见上面的 renderDisabled 分支）：它要图生图出图，
// 所以只能在有 ComfyUI 的阶段调用 —— 即「资产图」阶段（stages.js RENDER_STAGE_TOOLS.image）。
// chapters 传章节标题数组；返回两个子结果（generated/bound/notes/deferred）与可展示的汇总文本。
export async function resolveShotProvisions(ctx, chapters) {
  const outfit = await autoResolveOutfits(ctx, chapters);
  const age = await autoResolveAges(ctx, chapters);
  const lines = [];
  if (outfit.generated) lines.push('自动换装：生成服装资产 ' + outfit.generated + ' 套、绑定 ' + outfit.bound + ' 镜');
  if (age.generated) lines.push('自动年龄变体：生成 ' + age.generated + ' 个、绑定 ' + age.bound + ' 镜');
  const failed = [...(outfit.notes || []), ...(age.notes || [])].filter((n) => /失败/.test(n));
  if (failed.length) lines.push(failed.join('；'));
  return { outfit, age, text: lines.join('；') };
}

async function hListShots(ctx) {
  return JSON.stringify(Shots.list(ctx.projectId).map((s) => ({ id: s.id, idx: s.idx, chapter: s.chapter || '', scene_name: s.scene_name, status: s.status, has_prompt: !!(s.video_prompt && String(s.video_prompt).trim()), has_video: !!s.video_path, error: s.error, duration: s.duration })));
}

async function hUpdateShot(ctx, args) {
  // 归属校验：与其他写工具同口径（generate_shot_video / update_asset 都先比对 project_id）。
  // 不校验的话，传入别的项目的 shot_id 会改掉那个项目的分镜，而变更日志记在本项目名下 ——
  // 回滚时两边都对不上。顺带把分镜读一次复用，不重复查库。
  const shot = Shots.get(args.shot_id);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const patch = {};
  for (const k of ['sub_shots', 'dialogue', 'narration', 'camera', 'visual', 'duration', 'video_prompt', 'mode']) if (args[k] != null) patch[k] = args[k];
  // 视频生成模式枚举校验：非空且不在 VIDEO_MODES 内即拒绝（空串 = auto，走确定性推断兜底）
  if (args.mode != null && String(args.mode) && !VIDEO_MODES.includes(String(args.mode))) {
    throw new Error('mode 只能是 ' + VIDEO_MODES.join('/') + '（当前：' + args.mode + '）');
  }
  // 时长归一化后再落库：原先只用「裁剪后的值」做台词/时长校验，却把原值写进 DB ——
  // 校验与落库不是同一个数（-5、0、'8秒' 都能入库）。负时长会被原样传给 H3（seconds=-5），
  // 也会把本章总时长算成负数（背景音乐时长按总时长算），而字符串时长在 REAL 列里退化。
  if (args.duration != null) {
    const d = Number(args.duration);
    if (!Number.isFinite(d)) throw new Error('duration 必须是数字（秒）：' + args.duration);
    patch.duration = Math.min(SHOT_DURATION_MAX, Math.max(SHOT_DURATION_MIN, Math.trunc(d)));
  }
  // 若本次修改了台词或时长，同样做「台词字数 ≤ 时长×5」校验
  if (args.dialogue != null || args.duration != null) {
    // 时长缺省值与 db 层 / 外部写入 API 同一份（SHOT_DURATION_DEFAULT）：原先这里写死 8，
    // 与 SHOT_DURATION_DEFAULT=5 漂移 —— 历史行 duration 为空时，两条写入路径按不同的上限判台词。
    const dur = patch.duration != null ? patch.duration : (Number(shot.duration) > 0 ? Number(shot.duration) : SHOT_DURATION_DEFAULT);
    const chars = (patch.dialogue != null ? patch.dialogue : (shot.dialogue || '')).length;
    if (chars && chars / dur > SHOT_DIALOGUE_MAX_RATE) {
      throw new Error('台词与时长不匹配：中文旁白约 4-5 字/秒，当前 ' + chars + ' 字 / ' + dur + ' 秒（上限 ' + Math.floor(dur * SHOT_DIALOGUE_MAX_RATE) + ' 字）超速，会被压缩成听不清的模糊声。请缩短台词或延长时长。');
    }
  }
  // 若本次修改了台词，校验说话人数 ≤ MAX_SPEAKERS_PER_SHOT（多人对话需拆镜）
  if (args.dialogue != null) {
    const speakers = dialogueSpeakerNames(patch.dialogue);
    if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
      throw new Error('分镜对话人数过多：每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 个说话人，请拆成多个分镜。当前说话人：' + speakers.join('、'));
    }
  }
  Shots.update(args.shot_id, patch);
  return '已更新分镜';
}

function shotImageAbsPaths(ctx, shot) {
  const assets = Assets.list(ctx.projectId);
  const byId = (id) => assets.find((x) => x.id === id);
  const ids = [...(shot.character_ids || []), ...(shot.scene_ids || []), ...(shot.prop_ids || []), ...(shot.costume_ids || [])];
  return ids.map(byId).filter(Boolean).map((a) => resolveProjectPath(ctx.projectId, a.image_path)).filter(Boolean);
}

const REF_PLACEHOLDER_RE = /__MINIMAX_H3_REF_\d+__/g;

// 基于用户反馈重写视频提示词。要求 LLM 输出「完整重写结果」，并做三项校验：
//   非空、未被截断（finish_reason !== 'length'）、保留原提示词里的全部 __MINIMAX_H3_REF_N__ 占位符。
// 任一不满足：用更严格的指令重试一次；仍不满足则抛错——绝不把半截/丢参考的结果覆盖进资产。
// （实测踩坑：长提示词被模型摘缩成一句，REF_2/REF_3 全丢，视频随后「对不上」。）
async function rewritePromptWithFeedback(ctx, basePrompt, feedback, imageAbsPaths) {
  // 本批禁用 LLM（渲染 job / 渲染阶段）：不允许在渲染过程中拉起 LLM 抢显存。
  // 反馈改写是「可选 LLM 步骤」，此时要求走纯 LLM 批次改写后再渲染。
  if (ctx.llmDisabled) {
    throw new Error('本批已禁用 LLM（渲染批次）：不能调用 LLM 改写提示词。请先用「仅 LLM 改写」批次改写，再渲染；或去掉反馈直接渲染。');
  }
  const buildMsgs = (strict) => {
    // 改写语言由设置项 llm.rewriteLanguage 决定（same=与原提示词一致 / zh / en）
    const lang = { same: '保持与原提示词相同的语言', zh: '用中文输出', en: '用英文输出' }[ctx.cfg.llm?.rewriteLanguage] || '保持与原提示词相同的语言';
    const sys = '你是视频提示词改写助手。基于原提示词与用户反馈，输出改写后的完整提示词（' + lang + '，保留 __MINIMAX_H3_REF_N__ 占位符与参考标签不变）。只输出提示词文本。'
      + (strict ? '必须完整保留原提示词的全部信息（镜头、画面、时间轴、声音、结尾约束）与所有 __MINIMAX_H3_REF_N__ 占位符，不得缩写、不得只写开头。' : '');
    const msgs = [{ role: 'system', content: sys }];
    if (visionEnabled(ctx)) {
      const dataUrls = imagesFromPaths(imageAbsPaths, 9).map((i) => 'data:' + i.mimeType + ';base64,' + i.data);
      msgs.push(buildVisionUserMessage('原提示词：\n' + basePrompt + '\n\n反馈：' + feedback + '\n\n（附该分镜参考图，供改写参考）', dataUrls));
    } else {
      msgs.push({ role: 'user', content: '原提示词：\n' + basePrompt + '\n\n反馈：' + feedback });
    }
    return msgs;
  };
  const want = new Set(String(basePrompt).match(REF_PLACEHOLDER_RE) || []);
  // 改写最大输出 token 由设置项决定（默认 4000）：思考型模型的 reasoning 与正文共用该预算，
  // 预算不足时正文刚开头就被截断（改写只剩一两句、丢参考占位符）→ 视频画面对不上。
  const maxTokens = Math.max(256, Number(ctx.cfg.llm?.rewriteMaxTokens) || 4000);
  let reason = '未知原因';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llmChat(ctx.cfg.llm, buildMsgs(attempt > 0), { temperature: attempt > 0 ? 0.4 : 0.6, maxTokens });
    const out = String(r.content || '').trim();
    if (!out) { reason = 'LLM 返回为空'; continue; }
    if (r.finishReason === 'length') { reason = 'LLM 输出被截断（达到长度上限）'; continue; }
    const got = new Set(out.match(REF_PLACEHOLDER_RE) || []);
    const missing = [...want].filter((x) => !got.has(x));
    if (missing.length) { reason = 'LLM 改写丢失参考占位符 ' + missing.join('、'); continue; }
    return out;
  }
  throw new Error('LLM 改写提示词不可用（' + reason + '），已保留原提示词。请重试。');
}

// 视频任务的显存释放计数已上移到 workflow-runner.maybeFreeComfy（runWorkflow 统一出口），
// 覆盖全部 ComfyUI 生成（文生图/图生图/换装/音色/视频），不再局限视频。

// 准备单个分镜的渲染参数：组装参考素材 + 计算提示词/工作流/分辨率等，不写状态、不提交渲染。
// render=false（仅 LLM 改写）时直接落库并返回 { done }；否则返回渲染所需的 prepared 对象。
async function prepareShotForRender(ctx, shotId, { feedback, render = true } = {}) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const assets = Assets.list(ctx.projectId);
  // 文生视频（mode='text'）不连接任何媒体节点：跳过参考素材组装（assembleShotReferences 会因
  // 「至少 1 张参考图」抛错），references 留空、不绑定 media_*。
  // 非文生路径：render=false（仅 LLM 改写提示词）走纯文本，upload=false 不上传参考文件，
  // 但仍解析参考标签供 fallbackVideoPrompt 生成 __MINIMAX_H3_REF_N__ 占位符。
  const isText = shot.mode === 'text';
  const { references, characterName, characterDesc, sceneDesc, unmatchedSpeakers } = isText
    ? { references: [], characterName: '', characterDesc: '', sceneDesc: '', unmatchedSpeakers: [] }
    : await assembleShotReferences({ cfg: ctx.cfg, project: ctx.project, shot, assets, upload: render !== false });
  // 对白说话人没匹配到本镜角色（如「李雷，韩梅梅：台词」这类一行多说话人标签）→ 音色被静默跳过，
  // 用户只会看到「这一镜没声音」。上报一条可读提示到运行日志，别让它无声无息。
  if (unmatchedSpeakers && unmatchedSpeakers.length) {
    ctx.report({ phase: '参考素材', detail: '对白说话人未匹配到本镜角色，音色不会被引用：' + unmatchedSpeakers.join('、') + '（每行台词只写一个说话人，多个说话人拆成多行/多镜）' });
  }
  const timeErr = validateSubShots(shot.duration, shot.sub_shots);
  if (timeErr) throw new Error(timeErr);
  const base = shot.video_prompt || fallbackVideoPrompt({ references, style: ctx.project.style, characterDesc, sceneDesc, subShots: shot.sub_shots, camera: shot.camera, visual: shot.visual, dialogue: shot.dialogue, characterName });
  const prompt = feedback ? await rewritePromptWithFeedback(ctx, base, feedback, shotImageAbsPaths(ctx, shot)) : base;
  // render=false：只做 LLM 改写提示词，不提交 ComfyUI（改写结果落库，供用户复核后再渲染）
  if (render === false) {
    if (!feedback) throw new Error('仅 LLM 改写模式需要反馈文字');
    Shots.update(shot.id, { video_prompt: prompt, error: '' });
    ctx.report({ phase: '分镜提示词', detail: 'LLM 改写完成（未渲染）分镜 ' + shot.idx });
    return { done: JSON.stringify({ shot_id: shot.id, idx: shot.idx, video_prompt: prompt, rendered: false }) };
  }
  // 实际写入节点 2.mode：显式指定且在值域内则直用；未指定/空串走确定性推断兜底
  // （text 经 spec 的 mode.map 映射成节点 image = 文生，不连媒体）。
  const mode = (shot.mode && VIDEO_MODES.includes(shot.mode)) ? shot.mode : inferVideoMode(references);
  // 图生/首尾帧（image）只接受图片，不接受音/视频：否则媒体槽绑定与 mode=image 语义矛盾
  if (mode === 'image' && references.some((r) => r.type === 'audio' || r.type === 'video')) {
    throw new Error('image 模式（图生/首尾帧）只接受 0~2 张图片，不能携带音频/视频参考');
  }
  const spec = getSpecForKind(ctx.cfg, 'r2v');
  const reso = shot.resolution || ctx.project.video_resolution || '480P';
  const ratio = shot.aspect_ratio || ctx.project.video_aspect_ratio || '16:9';
  // 单个分镜生成 N 条候选视频（设置 → generation.videosPerShot，默认 1），用不同 seed 各渲染一条，
  // 用户随后在分镜审查页勾选一条优质候选用于导出成片。N 上限 10 防误配置爆炸。
  const shotsN = Math.max(1, Math.min(10, Math.floor(Number(ctx.cfg?.generation?.videosPerShot) || 1)));
  return { shot, prompt, mode, spec, reso, ratio, shotsN, references, prevStatus: shot.status, prevVideo: shot.video_path };
}

// 渲染单个候选视频（候选 idx，追加模式下从旧候选之后续接），成功返回 { id, idx, video_path, seed }；失败抛错。
async function renderShotCandidate(ctx, prepared, idx) {
  const { shot, prompt, mode, spec, reso, ratio, references } = prepared;
  const seed = randomSeed();
  const prefix = 'video/' + ctx.projectId.slice(0, 8) + '_shot' + shot.idx + '_' + uid().slice(0, 6);
  const wfParams = {
    positive_prompt: prompt,
    seconds: shot.duration || 5,
    aspect_ratio: ratio,
    resolution: reso,
    mode,
    seed, filename_prefix: prefix, references,
  };
  // 自定义分辨率：resolution 固定为 custom，宽高取自项目配置
  if (reso === 'custom') {
    wfParams.width = Number(ctx.project.video_width) || 1024;
    wfParams.height = Number(ctx.project.video_height) || 576;
  }
  const { outputs, prompt_id } = await runWorkflow(ctx.cfg, spec, wfParams, { jobId: ctx.jobId, unitId: 'shot:' + shot.id + ':cand:' + idx, projectId: ctx.projectId, chapter: shot.chapter || '', subject: '第' + shot.idx + '镜', dedupeKey: 'shot:' + shot.id + ':cand:' + idx, timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, onSubmitted: (pid) => Shots.update(shot.id, { prompt_id: pid }), onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); if (s.kind === 'waiting_release') ctx.report({ phase: '等待云端释放', detail: s.message }); } });
  const vid = pickOutput(outputs, 'videos');
  if (!vid) throw new Error('视频工作流未返回视频文件');
  const ext = path.extname(vid.filename) || '.mp4';
  const relPath = 'shots/shot' + shot.idx + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, vid, relPath);
  const sv = ShotVideos.create(ctx.projectId, shot.id, { idx, video_path: relPath, seed });
  Shots.update(shot.id, { seed, prompt_id: prompt_id || '' });
  return { id: sv.id, idx, video_path: relPath, seed };
}

// 收尾一个分镜：有候选则确定导出用候选、标 done；无候选按取消/失败复位。
// 成功返回结果对象；无候选时抛错（中断或失败）。
function finalizeShot(ctx, prepared, created, { aborted, interrupted, lastErr, append = false }) {
  const { shot, prompt, prevStatus, prevVideo } = prepared;
  if (created.length) {
    created.sort((a, b) => a.idx - b.idx); // 并发完成顺序不定，按候选序取第一条保证「默认选第一条」
    // 追加候选：保留用户之前勾选的候选（若有），否则选新增的第一条；替换/首次：默认选第一条。
    const keepSelected = append ? ShotVideos.selectedForShot(shot.id) : null;
    const first = keepSelected || created[0];
    ShotVideos.setSelected(shot.id, first.id);
    Shots.update(shot.id, { video_path: first.video_path, status: 'done', video_prompt_used: prompt, error: '', prompt_id: '' });
    return { shot_id: shot.id, idx: shot.idx, video_path: first.video_path, count: created.length };
  }
  if (aborted || interrupted) {
    if (prevStatus === 'done' && prevVideo) Shots.update(shot.id, { status: 'done', video_path: prevVideo, error: '' });
    else Shots.update(shot.id, { status: 'pending', video_path: prevVideo || '', error: '' });
  } else {
    Shots.update(shot.id, { status: 'failed', error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr || '生成失败'), video_path: prevVideo || '' });
  }
  throw lastErr || new Error(interrupted ? '生成已中断' : '生成失败');
}

// 单个分镜生成 N 条候选（单镜工具 / 重生成入口）：串行渲染该镜的 N 条候选。
// append=true 时「追加为新候选」——保留旧候选、新候选 idx 续接，用于「生成候选」按钮；
// append=false（默认）时「替换整批候选」——清掉旧候选、idx 从 0 起。
async function generateShotVideo(ctx, shotId, { feedback, render = true, append = false } = {}) {
  const prepared = await prepareShotForRender(ctx, shotId, { feedback, render });
  if (prepared.done) return prepared.done;
  const { shot, prompt, reso, ratio, shotsN } = prepared;
  // 依赖闸门（与 hGenerateChapterVideos 的 pendingShotAssets 同口径）：单镜直跑也不得在
  // 依赖资产（角色/场景/道具/服装/年龄）未生成完成时开渲染。否则 LLM Agent 会绕过
  // generate_chapter_videos 逐镜调用 generate_shot_video，导致「素材没生成完就出视频」。
  if (prepared.mode !== 'text') {
    const byId = new Map(Assets.list(ctx.projectId).map((a) => [a.id, a]));
    const pending = pendingShotAssets(ctx, shot, byId);
    if (pending.length) {
      throw new Error('分镜 ' + shot.idx + ' 依赖的资产尚未生成完成，请先生成资产图/服装再生成视频：' + pending.join('、'));
    }
  }
  const baseIdx = append ? ShotVideos.listByShot(shot.id).length : 0;
  Shots.update(shot.id, { status: 'generating', video_prompt: prompt, seed: 0, resolution: reso, aspect_ratio: ratio, error: '', prompt_id: '' });
  ctx.report({ phase: '分镜视频', detail: (append ? '追加候选 ' : '生成分镜 ') + shot.idx + (feedback ? '（重生成）' : '') + (shotsN > 1 ? ' ×' + shotsN + ' 条候选' : '') });
  // 追加模式保留旧候选；替换模式清空旧候选（旧候选磁盘文件按现状自然遗留）
  if (!append) ShotVideos.deleteByShot(shot.id);
  const created = [];
  let aborted = false;
  let interrupted = false;
  let lastErr = null;
  for (let i = 0; i < shotsN; i++) {
    if (aborted || interrupted || (ctx.isAborted && ctx.isAborted())) { aborted = true; break; }
    try {
      created.push(await renderShotCandidate(ctx, prepared, baseIdx + i));
    } catch (e) {
      if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
      if (e && e.interrupted) { interrupted = true; lastErr = e; break; }
      lastErr = e;
      ctx.report({ phase: '分镜视频', detail: '分镜 ' + shot.idx + ' 候选 ' + (i + 1) + '/' + shotsN + ' 失败：' + (e && e.message ? e.message : String(e)) });
    }
  }
  if (created.length) return JSON.stringify(finalizeShot(ctx, prepared, created, { aborted, interrupted, lastErr, append }));
  finalizeShot(ctx, prepared, created, { aborted, interrupted, lastErr, append }); // 无候选 → 抛错
}

async function hGenerateShotVideo(ctx, args) { return generateShotVideo(ctx, args.shot_id); }
async function hRegenerateShot(ctx, args) { return generateShotVideo(ctx, args.shot_id, { feedback: args.feedback, render: args.render !== false, append: !!args.append }); }
// 镜头依赖判定：镜头引用的角色/场景/道具（含服装/年龄变体）必须**已经生成完成**，
// 该镜头才能进渲染队列。只统计「能解析到资产」的引用——悬空 id 不阻塞
// （参考图组装时会直接跳过它，阻塞一个永远补不上的依赖没有意义）。
function pendingShotAssets(ctx, shot, byId) {
  const pending = [];
  const check = (ids, label) => {
    for (const id of ids || []) {
      const a = byId.get(id);
      if (!a) continue;
      const done = a.status === 'done' && a.image_path && fs.existsSync(resolveProjectPath(ctx.projectId, a.image_path));
      if (!done) pending.push((a.name || a.id) + '·' + label);
    }
  };
  check(shot.character_ids, '角色');
  check(shot.scene_ids, '场景');
  check(shot.prop_ids, '道具');
  check(shot.costume_ids, '服装');
  check(shot.age_ids, '年龄');
  return pending;
}

async function hGenerateChapterVideos(ctx, args) {
  // chapter 与 set_chapter_music 统一走 chapterByRef：标题或 id 都认（get_project / list_chapters
  // 同时给出两者，模型传哪个都得对）。之前只按标题过滤分镜，模型传章节 id 时会静默返回
  // 「本章没有分镜」——一个看似正常的空结果，任务却什么都没做。
  const title = chapterByRef(ctx, args && args.chapter).title;
  const force = !!(args && args.force);
  const all = Shots.list(ctx.projectId).filter((s) => s.chapter === title);
  if (!all.length) return JSON.stringify({ chapter: title, total: 0, generated: 0, remaining: 0, note: '本章没有分镜' });
  // 未指定 force 时跳过「已出片且视频提示词未变过」的镜头；提示词被改写（如「仅 LLM 改写」）过就重渲染
  const target = force ? all : all.filter((s) => s.status !== 'done' || (s.video_prompt_used || '') !== (s.video_prompt || ''));
  const runCount = target.length;

  // 依赖感知调度：先把「引用的资产都已完成」的镜头挑出来，其余等待。
  // 章节视频无论本地 ComfyUI 还是云端 RunningHub，都按 idx 升序**逐镜串行**（见下方 runOne），
  // 否则每个分镜都会在抢槽前就被标成 generating，界面看起来像全部并发生成、顺序也乱。
  const byId = new Map(Assets.list(ctx.projectId).map((a) => [a.id, a]));
  const readiness = target.map((shot) => ({ shot, pending: pendingShotAssets(ctx, shot, byId) }));
  const ready = readiness.filter((r) => r.pending.length === 0).map((r) => r.shot);
  const waiting = readiness.filter((r) => r.pending.length > 0);

  if (waiting.length) {
    const sample = waiting.slice(0, 3).map((r) => '第' + r.shot.idx + '镜←' + r.pending.join('/')).join('；');
    ctx.report({ phase: '分镜视频', detail: '暂缓 ' + waiting.length + ' 镜（依赖资产未完成）：' + sample + (waiting.length > 3 ? ' …' : '') });
  }
  if (!ready.length) {
    return JSON.stringify({
      chapter: title, total: all.length, generated: 0, failed: 0,
      remaining: all.filter((s) => s.status !== 'done').length,
      deferred: waiting.length,
      note: '本章所有待生成镜头都还有未完成的依赖资产，请先生成资产图/服装后再重试',
    });
  }

  // 1) 先为所有就绪分镜组装参考素材 / 提示词（prepare 只计算，不写状态、不提交渲染），
  //    这样候选渲染的「全局顺序」由下方队列决定，不受各镜参考图上传耗时影响。
  const preparedList = [];
  for (const s of ready) {
    if (ctx.isAborted && ctx.isAborted()) break;
    preparedList.push(await prepareShotForRender(ctx, s.id, {}));
  }

  // 2) 按分镜 idx 顺序逐镜生成：一个分镜的候选全部结束后，才开始下一镜。
  //    同一镜的候选可以并发（最多 limit 条），但不会让第 2 镜抢到第 1 镜前面。
  const limit = renderConcurrencyLimit(ctx.cfg);
  ctx.report({ phase: '分镜视频', detail: '按分镜顺序生成 ' + ready.length + '/' + runCount + ' 镜（每镜候选 ' + (preparedList[0]?.shotsN || 1) + '，并发 ' + limit + '）' });

  const started = new Set();        // 已标 generating 并清掉旧候选的分镜
  const okByShot = new Map();       // shotId -> [{id,idx,video_path,seed}]
  const errByShot = new Map();      // shotId -> [Error]
  const finalized = new Set();      // 已收尾的分镜
  let ok = 0, fail = 0, aborted = false;

  // 收尾单个分镜：有候选 → done 并默认选第一条；无候选 → 按取消/失败复位。
  const finalizeOne = (prepared) => {
    const shot = prepared.shot;
    const created = (okByShot.get(shot.id) || []).sort((a, b) => a.idx - b.idx);
    const errs = errByShot.get(shot.id) || [];
    if (created.length) {
      finalizeShot(ctx, prepared, created, { aborted: false, interrupted: false, lastErr: errs[0] || null });
      ok++;
      ctx.report({ phase: '分镜视频', detail: '已完成 ' + (ok + fail) + '/' + preparedList.length + ' 镜（成功 ' + ok + ' / 失败 ' + fail + '）' });
    } else if (aborted) {
      // 被停止/中断：只有真正进入过渲染（标过 generating）的分镜才复位；从未开始的分镜保持原状。
      if (started.has(shot.id)) {
        if (prepared.prevStatus === 'done' && prepared.prevVideo) Shots.update(shot.id, { status: 'done', video_path: prepared.prevVideo, error: '' });
        else Shots.update(shot.id, { status: 'pending', video_path: prepared.prevVideo || '', error: '' });
      }
    } else {
      fail++;
      Shots.update(shot.id, { status: 'failed', error: (errs[0] && errs[0].message) ? errs[0].message : '生成失败', video_path: prepared.prevVideo || '' });
      ctx.report({ phase: '分镜视频', detail: '第' + shot.idx + '镜失败：' + ((errs[0] && errs[0].message) || '生成失败') });
    }
  };

  for (const prepared of preparedList) {
    if (aborted || (ctx.isAborted && ctx.isAborted())) { aborted = true; break; }
    const shot = prepared.shot;
    started.add(shot.id);
    // 分镜进入渲染时才标 generating（并清掉上一版候选），「生成中」只落在真正在跑的分镜上。
    Shots.update(shot.id, { status: 'generating', video_prompt: prepared.prompt, seed: 0, resolution: prepared.reso, aspect_ratio: prepared.ratio, error: '', prompt_id: '' });
    ctx.report({ phase: '分镜视频', detail: '生成 ' + shot.idx + '/' + runCount + (prepared.shotsN > 1 ? '（×' + prepared.shotsN + ' 候选）' : '') });
    ShotVideos.deleteByShot(shot.id);

    const created = [];
    const errs = [];
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= prepared.shotsN || aborted) break;
        if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
        try {
          created.push(await renderShotCandidate(ctx, prepared, i));
        } catch (e) {
          if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
          if (e && e.interrupted) { aborted = true; break; }
          errs.push(e);
          ctx.report({ phase: '分镜视频', detail: '分镜 ' + shot.idx + ' 候选 ' + (i + 1) + '/' + prepared.shotsN + ' 失败：' + (e && e.message ? e.message : String(e)) });
        }
      }
    };
    // 同一镜的候选并行度不超过配置的渲染并发；不同分镜之间严格串行。
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, prepared.shotsN)) }, () => worker()));
    okByShot.set(shot.id, created);
    errByShot.set(shot.id, errs);
    finalized.add(shot.id);
    finalizeOne(prepared);
    if (aborted) break;
  }

  // 被停止/中断时，有分镜的候选没跑满（worker 提前 break），这里兜底收尾：
  // 有成功候选 → done；无成功候选且进入过渲染 → 复位；从未渲染 → 保持原状。
  for (const p of preparedList) {
    if (finalized.has(p.shot.id)) continue;
    finalized.add(p.shot.id);
    finalizeOne(p);
  }

  const remaining = Shots.list(ctx.projectId).filter((s) => s.chapter === title && s.status !== 'done').length;
  const base = { chapter: title, total: all.length, generated: ok, failed: fail, remaining };
  if (aborted) return JSON.stringify({ ...base, aborted: true });
  if (waiting.length) return JSON.stringify({ ...base, deferred: waiting.length, note: '有 ' + waiting.length + ' 镜因依赖资产未完成而暂缓' });
  return JSON.stringify(base);
}

async function hAssembleVideo(ctx, args) {
  // 只有显式传了 chapter 才按章合并（不传 = 整片合并，沿用原行为）；
  // 章节引用同样支持标题或 id —— 之前过滤分镜只按标题、找 BGM 却按「标题或 id」，
  // 传 id 时会报「章节没有已完成的分镜视频」，而该章其实有片子。
  const ch = (args && args.chapter) ? chapterByRef(ctx, args.chapter) : null;
  const chapter = ch ? ch.title : '';
  // 顺序：先章节 seq 再章内 idx（多章合并时按全局 idx 会交叉成「第1章第1镜、第2章第1镜…」）
  let done = Shots.listInNarrativeOrder(ctx.projectId).filter((s) => s.video_path && s.status === 'done');
  if (chapter) done = done.filter((s) => s.chapter === chapter);
  if (!done.length) throw new Error(chapter ? ('章节「' + chapter + '」没有已完成的分镜视频') : '没有已完成的分镜视频');
  const inputs = done.map((s) => resolveProjectPath(ctx.projectId, s.video_path)).filter(Boolean);
  const base = chapter ? slugify(ctx.project.name) + '_' + slugify(chapter) : slugify(ctx.project.name);
  const outRel = 'exports/' + base + '_' + uid().slice(0, 8) + '.mp4';
  const outAbs = resolveProjectPath(ctx.projectId, outRel);
  // 背景音乐：仅按章合并时，把该章已生成的 BGM 垫底混入
  let music;
  if (ch) {
    const musicAbs = ch.music_path ? resolveProjectPath(ctx.projectId, ch.music_path) : null;
    if (musicAbs && fs.existsSync(musicAbs)) music = { path: musicAbs, volume: 0.25 };
  }
  ctx.report({ phase: '导出', detail: '合并 ' + inputs.length + ' 段视频' + (music ? '（垫入背景音乐）' : '') });
  // 字幕：项目开启「自动添加字幕」时，把本章台词/旁白烧录进成片（硬字幕，不额外产出 .srt 文件）。
  // 字幕是烧进画面的，无法从成片里再去掉 → 同时单独合一份不带字幕的版本，供下载时二选一。
  const subtitles = ctx.project.enable_subtitles !== false ? buildSrt(done) : '';
  const noSubRel = outRel.replace(/(\.[^.]+)$/, '_nosub$1');
  await mergeVideos(inputs, outAbs, { music, isAborted: ctx.isAborted, subtitles });
  let srtRel = '';
  if (subtitles) {
    await mergeVideos(inputs, resolveProjectPath(ctx.projectId, noSubRel), { music, isAborted: ctx.isAborted });
    // 附带一份 SRT 字幕文件：不进成片列表，只作为「下载字幕」按钮的素材
    srtRel = outRel.replace(/\.[^.]+$/, '.srt');
    fs.writeFileSync(resolveProjectPath(ctx.projectId, srtRel), subtitles, 'utf8');
  }
  await recordExportUsage(ctx, chapter ? 1 : new Set(done.map((s) => s.chapter || '')).size);
  return JSON.stringify({ export_path: outRel, shots: done.length, chapter: chapter || null, music: !!music, subtitled: !!subtitles, nosub_path: subtitles ? noSubRel : '', srt_path: srtRel });
}

function chapterByRef(ctx, ref) {
  const title = String(ref || ctx.chapter || '').trim();
  if (!title) throw new Error('请指定章节 chapter');
  const ch = Chapters.list(ctx.projectId).find((c) => c.title === title || c.id === title);
  if (!ch) throw new Error('章节不存在：' + title);
  return ch;
}

async function hSetChapterMusic(ctx, args) {
  const ch = chapterByRef(ctx, args && args.chapter);
  const caption = String((args && args.caption) || '').trim();
  if (!caption) throw new Error('请提供音乐风格描述 caption');
  const lyrics = String((args && args.lyrics) || '').trim();
  const duration = (args && args.duration != null) ? Number(args.duration) : 0;
  Chapters.update(ch.id, { music_prompt: JSON.stringify({ caption, lyrics, duration }) });
  return JSON.stringify({ chapter: ch.title, caption, lyrics, duration });
}

async function hGenerateMusic(ctx, args) {
  // 项目设置「是否生成背景音乐」关闭时，自动流水线跳过（音乐库手动生成/应用不受此限制）
  if (ctx.project.enable_bgm === false) {
    return JSON.stringify({ chapter: args && args.chapter, skipped: true, note: '项目已关闭「是否生成背景音乐」' });
  }
  const ch = chapterByRef(ctx, args && args.chapter);
  let prompt = {};
  try { prompt = JSON.parse(ch.music_prompt || '{}'); } catch {}
  const caption = String(prompt.caption || '').trim()
    || ((ctx.project.style || '').trim() ? ctx.project.style + '，轻柔舒缓的背景音乐' : '轻柔舒缓的背景音乐');
  const lyrics = String(prompt.lyrics || '').trim();
  const promptKey = JSON.stringify({ caption, lyrics });
  // 幂等：已生成且提示词未变，直接跳过
  const existingAbs = ch.music_path ? resolveProjectPath(ctx.projectId, ch.music_path) : null;
  if ((ch.music_prompt_used || '') === promptKey && existingAbs && fs.existsSync(existingAbs)) {
    return JSON.stringify({ chapter: ch.title, music_path: ch.music_path, skipped: true });
  }
  const shots = Shots.list(ctx.projectId).filter((s) => s.chapter === ch.title);
  const total = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  if (total <= 0) return JSON.stringify({ chapter: ch.title, skipped: true, note: '本章没有分镜，无法确定背景音乐时长' });
  // 时长：优先 LLM 给的 duration，否则该章全部分镜 duration 之和（不封顶）
  const max_duration = Number(prompt.duration) > 0
    ? Math.max(1, Number(prompt.duration))
    : Math.max(1, Math.round(total * 10) / 10);

  const spec = getSpecForKind(ctx.cfg, 'music');
  const prefix = 'music/' + slugify(ctx.project.name) + '_' + slugify(ch.title) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '背景音乐', detail: '生成背景音乐：' + ch.title });
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    caption, lyrics: lyrics || ' ', max_duration, seed: randomSeed(), filename_prefix: prefix,
  }, { timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: ch.title, subject: ch.title + ' BGM', dedupeKey: 'music:' + ch.id, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const aud = pickOutput(outputs, 'audio');
  if (!aud) throw new Error('背景音乐工作流未返回音频');
  const ext = path.extname(aud.filename) || '.mp3';
  const relPath = 'assets/music/' + slugify(ctx.project.name) + '_' + slugify(ch.title) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, aud, relPath);
  Chapters.update(ch.id, { music_path: relPath, music_prompt_used: promptKey });
  // 自动生成的 BGM 也入库「背景音乐库」，便于用户预览/选择（同名复用，见 upsertMusicAsset）
  const assetId = upsertMusicAsset(ctx, ch.title + '背景音乐', { audio_path: relPath, prompt: caption, prompt_used: caption, lyrics, max_duration, source: 'generated', status: 'done' });
  return JSON.stringify({ chapter: ch.title, music_path: relPath, asset_id: assetId, duration: max_duration });
}

async function hGenerateMusicAsset(ctx, args) {
  const asset = (args && args.asset_id) ? Assets.get(args.asset_id) : null;
  if (!asset || asset.project_id !== ctx.projectId || asset.category !== 'music') throw new Error('背景音乐资产不存在');
  const caption = String(asset.prompt || '').trim();
  if (!caption) throw new Error('缺少音乐描述 caption');
  const lyrics = String(asset.lyrics || '').trim();
  // 时长：优先资产里写好的 max_duration；否则按项目总视频时长（不封顶）；未生成视频时默认 60s
  const shots = Shots.list(ctx.projectId);
  const total = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const max_duration = Number(asset.max_duration) > 0
    ? Math.max(1, Number(asset.max_duration))
    : (total > 0 ? Math.max(1, Math.round(total * 10) / 10) : 60);

  const spec = getSpecForKind(ctx.cfg, 'music');
  const prefix = 'music/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '背景音乐', detail: '生成背景音乐：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  try {
    const { outputs } = await runWorkflow(ctx.cfg, spec, {
      caption, lyrics: lyrics || ' ', max_duration, seed: randomSeed(), filename_prefix: prefix,
    }, { timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: '', subject: asset.name || asset.id, dedupeKey: 'music-asset:' + asset.id, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const aud = pickOutput(outputs, 'audio');
    if (!aud) throw new Error('背景音乐工作流未返回音频');
    const ext = path.extname(aud.filename) || '.mp3';
    const relPath = 'assets/music/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, aud, relPath);
    Assets.update(asset.id, { audio_path: relPath, prompt_used: caption, source: 'generated', status: 'done', error: '' });
    return JSON.stringify({ asset_id: asset.id, name: asset.name, music_path: relPath, duration: max_duration });
  } catch (e) {
    // 失败/被停止时不能把**已有的音频**一起作废：重新生成前资产上那条 audio_path 仍是可用产物
    // （列表里还在播、用户还等着用它「应用到章节」），置成 failed 会让「应用到」直接消失。
    // 与分镜同口径：取消时保留已完成结果，只在确实没有音频时才标失败。
    const aborted = !!(ctx.isAborted && ctx.isAborted());
    if (aborted && asset.audio_path) Assets.update(asset.id, { status: 'done', error: e.message });
    else Assets.update(asset.id, { status: 'failed', error: e.message });
    throw e;
  }
}

// 简单模式页（视频生成 / 数字人）的独立视频资产生成：不走分镜流水线，直接以「上传的参考物料 +
// 模式」跑 r2v 工作流，产物落为 video 资产。数字人 = mode=digital_human（视觉参考 + 单条驱动音频）。
async function hGenerateVideoAsset(ctx, args) {
  const asset = (args && args.asset_id) ? Assets.get(args.asset_id) : null;
  if (!asset || asset.project_id !== ctx.projectId || asset.category !== 'video') throw new Error('视频资产不存在');
  const mode = String((args && args.mode) || 'reference');
  if (!VIDEO_MODES.includes(mode)) throw new Error('mode 只能是 ' + VIDEO_MODES.join('/') + '（当前：' + mode + '）');
  const prompt = String((args && args.prompt) || asset.prompt || '').trim();
  if (!prompt) throw new Error('缺少视频提示词 prompt');

  // 上传本地物料到渲染后端，得到 ComfyUI 认识的输入文件名（Native=本地名，RunningHub=平台 fileName）
  const refs = Array.isArray(args.references) ? args.references : [];
  const references = [];
  for (const r of refs) {
    const type = r.type === 'audio' || r.type === 'video' ? r.type : 'image';
    const rel = String(r.filename || r.path || '').trim();
    if (!rel) continue;
    const abs = resolveProjectPath(ctx.projectId, rel);
    if (!abs || !fs.existsSync(abs)) throw new Error('参考物料不存在：' + rel);
    const ext = path.extname(abs) || (type === 'audio' ? '.flac' : type === 'video' ? '.mp4' : '.png');
    const name = 'ic_' + ctx.projectId.slice(0, 8) + '_' + type + '_' + uid().slice(0, 8) + ext;
    const filename = await uploadTaskInput(ctx.cfg, abs, name);
    references.push({ type, filename, label: type });
  }

  // 模式与物料组合约束
  const images = references.filter((r) => r.type === 'image').length;
  const audios = references.filter((r) => r.type === 'audio').length;
  const videos = references.filter((r) => r.type === 'video').length;
  if (mode === 'image') {
    if (audios || videos) throw new Error('图生/首尾帧模式只能连接图片（当前混入了音频/视频）');
    if (images < 1 || images > 2) throw new Error('图生/首尾帧模式需 1–2 张图片（当前 ' + images + ' 张）');
  } else if (mode === 'reference') {
    if (images + videos < 1) throw new Error('参考生视频模式至少需要 1 张图片或 1 段视频');
    if (images > 9) throw new Error('参考图片最多 9 张（当前 ' + images + ' 张）');
    if (audios + videos > 3) throw new Error('参考音视频最多 3 段（当前 ' + (audios + videos) + ' 段）');
  } else if (mode === 'digital_human') {
    if (images !== 1) throw new Error('数字人模式需 1 张视觉参考（头像），当前 ' + images + ' 张');
    if (audios !== 1 || videos) throw new Error('数字人模式需且仅需 1 条驱动音频，当前音频 ' + audios + ' / 视频 ' + videos);
  }

  const reso = String((args && args.resolution) || '480P');
  const ratio = String((args && args.aspect_ratio) || '16:9');
  const seconds = Number(args && args.seconds) > 0 ? Number(args.seconds) : 5;
  const spec = getSpecForKind(ctx.cfg, 'r2v');
  const prefix = 'video/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '视频生成', detail: '生成视频：' + asset.name + '（' + mode + '）' });
  Assets.update(asset.id, { status: 'generating', prompt });
  try {
    const wfParams = { positive_prompt: prompt, seconds, aspect_ratio: ratio, resolution: reso, seed: randomSeed(), filename_prefix: prefix, references, mode };
    const { outputs } = await runWorkflow(ctx.cfg, spec, wfParams, { jobId: ctx.jobId, timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const vid = pickOutput(outputs, 'videos');
    if (!vid) throw new Error('视频工作流未返回视频文件');
    const ext = path.extname(vid.filename) || '.mp4';
    const relPath = 'assets/videos/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, vid, relPath);
    Assets.update(asset.id, { video_path: relPath, prompt_used: prompt, source: 'generated', status: 'done' });
    return JSON.stringify({ asset_id: asset.id, name: asset.name, video_path: relPath, mode });
  } catch (e) {
    const aborted = !!(ctx.isAborted && ctx.isAborted());
    if (aborted && asset.video_path) Assets.update(asset.id, { status: 'done' });
    else Assets.update(asset.id, { status: 'failed' });
    throw e;
  }
}

async function hApplyChapterMusic(ctx, args) {
  const musicId = args && args.music_id;
  const music = musicId ? Assets.get(musicId) : null;
  if (!music || music.project_id !== ctx.projectId || music.category !== 'music') throw new Error('背景音乐不存在');
  if (!music.audio_path) throw new Error('该背景音乐还没有音频文件');
  const titles = (Array.isArray(args && args.chapters) ? args.chapters : []).filter(Boolean);
  if (!titles.length) throw new Error('请选择要应用的章节');
  const results = [];
  let aborted = false;
  for (const t of titles) {
    // 与 hGenerateChapterVideos 一致：停止后不再继续合并后续章节（每章合并都是一次数十秒的 ffmpeg）
    if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
    const ch = Chapters.list(ctx.projectId).find((c) => c.title === t || c.id === t);
    if (!ch) { results.push({ chapter: t, error: '章节不存在' }); continue; }
    const shots = Shots.list(ctx.projectId).filter((s) => s.chapter === ch.title);
    if (!shots.length || shots.some((s) => s.status !== 'done' || !s.video_path)) {
      results.push({ chapter: ch.title, error: '尚未全部生成完成' });
      continue;
    }
    // 单章失败不能中断后续章节：这是批量动作，用户期望「能应用的都应用上，失败的列出来」。
    // 原先一次合并抛错会让后面所有章节都不再处理（前几章已改了 music_path，后面几章连碰都没碰）。
    try {
      Chapters.update(ch.id, { music_path: music.audio_path });
      const r = await hAssembleVideo(ctx, { chapter: ch.title });
      results.push({ chapter: ch.title, applied: true, export_path: JSON.parse(r).export_path });
    } catch (e) {
      results.push({ chapter: ch.title, error: '已写入背景音乐，但合并成片失败：' + e.message });
    }
  }
  // 全失败不能静默返回结果：任务会被记成 done，前端弹「任务完成」、按钮提示「已重新合成成片」，
  // 而用户其实什么都没得到。逐章原因带进错误里（日志/任务详情仍能看到是哪一章、为什么）。
  // aborted 时不抛：用户主动停止属于「取消」，不是失败（与阶段任务的停止语义一致）。
  if (!aborted && results.length && results.every((r) => r.error)) {
    throw new Error('所有章节都未能应用背景音乐：' + results.map((r) => r.chapter + '（' + r.error + '）').join('；'));
  }
  await recordExportUsage(ctx, results.filter((r) => !r.error).length);
  return JSON.stringify({ music_id: musicId, results, aborted });
}

async function hListWorkflows() {
  return JSON.stringify(Workflows.list().map((w) => ({ id: w.id, name: w.name, kind: w.kind, sourceFile: w.sourceFile })));
}

const HANDLERS = {
  get_project: hGetProject,
  save_context: hSaveContext,
  skill: hLoadSkill,
  skill_reference: hSkillReference,
  report: hReport,
  list_chapters: hListChapters,
  list_assets: hListAssets,
  create_asset: hCreateAsset,
  update_asset: hUpdateAsset,
  generate_asset_image: hGenerateAssetImage,
  edit_asset_image: hEditAssetImage,
  change_outfit: hChangeOutfit,
  design_outfits: hDesignOutfits,
  change_age: hChangeAge,
  design_ages: hDesignAges,
  view_asset: hViewAsset,
  view_shot_references: hViewShotReferences,
  view_project_references: hViewProjectReferences,
  web_search: hWebSearch,
  download_reference_image: hDownloadReferenceImage,
  register_voice: hRegisterVoice,
  design_voice: hDesignVoice,
  generate_assets_batch: hGenerateAssetsBatch,
  generate_asset_from_reference: hGenerateAssetFromReference,
  set_storyboard: hSetStoryboard,
  list_shots: hListShots,
  update_shot: hUpdateShot,
  generate_shot_video: hGenerateShotVideo,
  regenerate_shot: hRegenerateShot,
  generate_chapter_videos: hGenerateChapterVideos,
  assemble_video: hAssembleVideo,
  set_chapter_music: hSetChapterMusic,
  generate_music: hGenerateMusic,
  generate_music_asset: hGenerateMusicAsset,
  generate_video_asset: hGenerateVideoAsset,
  apply_chapter_music: hApplyChapterMusic,
  list_workflows: hListWorkflows,
};

export async function runTool(ctx, name, args) {
  // 运行时安全守卫：扫描工具参数，命中危险命令/危险参数即拦截该次调用（不终止任务）。
  const g = guardToolCall(name, args || {});
  if (g.blocked) {
    const msg = '[安全拦截] 工具 ' + name + ' 命中危险规则 ' + g.rule + '（' + g.severity + '）：' + g.message;
    logger.warn('guard: ' + msg, { name, rule: g.rule, severity: g.severity });
    if (ctx.report) ctx.report({ phase: '安全拦截', detail: msg });
    return JSON.stringify({ blocked: true, tool: name, rule: g.rule, severity: g.severity, message: g.message });
  }
  // 封闭参数校验：拒绝未在工具 schema 中声明的顶层参数字段（未知字段=硬错误，不静默丢弃）。
  const allowedKeys = ALLOWED_ARG_KEYS.get(name);
  if (allowedKeys) {
    const unknown = Object.keys(args || {}).filter((k) => !allowedKeys.has(k));
    if (unknown.length) {
      const msg = '[安全拦截] 工具 ' + name + ' 含未声明参数：' + unknown.join(', ');
      logger.warn('guard: ' + msg, { name, unknown });
      if (ctx.report) ctx.report({ phase: '安全拦截', detail: msg });
      return JSON.stringify({ blocked: true, tool: name, rule: 'unknown-args', message: '未声明的参数字段：' + unknown.join(', ') });
    }
  }
  const h = HANDLERS[name];
  if (!h) throw new Error('未知工具：' + name);
  // 只跑 LLM 的阶段：渲染工具一律跳过。这里刻意「返回」而不是抛错——
  // 抛错会让 Agent 把同一个必然失败的调用反复重试，白烧 token 且跑不到收尾。
  // 例外：regenerate_shot 的 render=false 是纯 LLM 改写提示词（不提交 ComfyUI），LLM 阶段放行。
  const llmOnlyCall = name === 'regenerate_shot' && args && args.render === false;
  if (ctx.renderDisabled && RENDER_TOOLS.has(name) && !llmOnlyCall) {
    const reason = '渲染需另起一批（ComfyUI 与 LLM 抢显存，本阶段不启动 ComfyUI）';
    logger.warn('stage: 跳过渲染工具', { name });
    if (ctx.report) ctx.report({ phase: '渲染已跳过', detail: name + '：' + reason });
    return JSON.stringify({ skipped: true, tool: name, reason });
  }
  logger.debug('agent tool', { name, args });
  // 内置 Agent 的内容写入同样进变更日志（source=agent:<tool>），与 UI / 外部 harness 一致
  return await withWriteContext('agent:' + name, () => h(ctx, args || {}));
}
