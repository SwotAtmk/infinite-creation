import { Chapters, ReferenceImages } from '../core/index.js';
import { filterReferenceImages, SKILL_PIPELINE_NODES } from '../shared/index.js';
import { loadSkill, listSkills } from './skill-engine.js';
import { targetChapterIdSet } from './tools.js';

export const REFERENCE_INSTRUCTION = `

【参考图片素材】用户本次上传了参考图片素材。请先用视觉能力逐张分析这些参考图的内容、画面风格、角色/场景/道具等元素，然后用 generate_asset_from_reference（图生图/i2i）以这些参考图为输入派生风格/设定一致的新素材（角色/场景/道具/服装等），而不是一律文生图。这些参考图仅作「生成新素材的参考」，不要把它们直接当成品素材使用，而是据此派生新素材。`;

// 构造用户任务提示词（内置 Agent 与外部 Agent 共用，保证续跑语义一致）
export function buildTaskPrompt(ctx) {
  let chapters = Chapters.list(ctx.projectId).map((c) => ({ id: c.id, title: c.title, novel: c.novel, hasScript: !!String(c.script || '').trim(), scriptChars: String(c.script || '').length }));
  const target = ctx.chapter || '';
  if (target) chapters = chapters.filter((c) => c.title === target || c.id === target);
  const seed = JSON.stringify({
    project: { name: ctx.project.name, style: ctx.project.style, idea: ctx.project.idea || '' },
    targetChapter: target || null,
    chapters,
    novel: chapters.map((c) => c.novel).join('\n\n').slice(0, 6000),
  });
  return (ctx.renderDisabled ? '开始执行：本批只做文本创作，不要调用任何渲染工具。\n' : '开始执行：请把下面的项目完成到成片导出。\n') + seed;
}

// 参考图的文本描述（外部 Agent 通过 view_project_references 查看图片，不内联图片块）
export function buildReferenceDescription(ctx) {
  const refs = filterReferenceImages(ReferenceImages.list(ctx.projectId, { mode: 'reference' }), targetChapterIdSet(ctx));
  const lines = [];
  let idx = 0;
  for (const r of refs) {
    idx += 1;
    const parts = ['参考图' + idx + '（reference_id=' + r.id + '）：' + (r.name || '未命名')];
    if (r.description) parts.push('用途/剧情定位：' + r.description);
    lines.push(parts.join('；'));
  }
  return { refs, descText: lines.join('\n') };
}

// 由 skillPipeline 配置生成「技能→任务映射」文案（替代原先硬编码在提示词里的映射）。
// nodes 缺项/坏值时回退到节点默认；fallback 非 false 时额外提示「可自动匹配其它技能」。
export function renderPipelineSkillMap(pipelineCfg) {
  const nodes = (pipelineCfg && pipelineCfg.nodes) || {};
  const lines = [];
  for (const meta of SKILL_PIPELINE_NODES) {
    const node = nodes[meta.id] || {};
    const skills = Array.isArray(node.skills) ? node.skills.map((s) => String(s).trim()).filter(Boolean) : [];
    const fallback = node.fallback !== false;
    if (!skills.length) {
      lines.push(meta.label + '（' + meta.desc + '）→' + (fallback ? '按技能目录自动匹配' : '未指定技能'));
      continue;
    }
    const refs = skills.map((s) => 'skill(' + s + ')').join('、');
    lines.push(meta.label + '（' + meta.desc + '）→先 ' + refs + (fallback ? '（这些用不上时自动匹配其它技能）' : ''));
  }
  return '技能→任务映射：' + lines.join('；') + '。';
}

export function buildSystemPrompt({ ctx, skillName, external }) {
  const skill = loadSkill(skillName || 'novel-to-video');
  const parts = [];
  parts.push('你是「无限创作」的自主创作 Agent，负责把小说/故事全自动改编为带语音的视频成片。你拥有调用本地 ComfyUI（MiniMax H3 视频 + Qwen-Image/Krea2 文生图/图生图 + Qwen3-TTS 音色）与 ffmpeg 的能力。');
  parts.push('铁律：全程自主决策，不要向用户询问中间确认；遇到失败先重试、再降级、最后记录并继续；操作必须幂等（已完成资产/分镜跳过），以便断点续跑。');
  parts.push('工具边界铁律：你只有下面列出的领域工具（以及用于按名字检索领域工具的 ToolSearch）。除 web_search（查资料/搜图）与 download_reference_image（下载一张图片到项目参考图）这两项联网能力外，你没有任何 shell/命令行/文件读写/子代理工具。技能文档里出现的 python / bash / npm / node / 脚本 等命令，或「运行脚本 / 执行命令 / 读文件」一类步骤，一律不要尝试执行（调用会被直接拒绝，反复尝试只会空转、浪费时间）；凡文档声称「跑脚本才能得到」的产物，改用领域工具（list_*/get_*/generate_*/set_*/update_*/skill_reference 等）本身完成，或直接忽略该脚本步骤。web_search / download_reference_image 会由系统在后台替你执行，你只需按工具参数调用即可。');
parts.push('【不确定就要搜】遇到你不知道或不确凿的事实——品牌名、产品型号、年代物品的真实外观、专业术语、历史/地理/科技细节、真实存在的服饰/道具样式等——必须先调用 web_search(type=web) 查证，再据结果理解上下文或改写描述/提示词，禁止凭空臆造年代/品牌/型号错误。需要某物品/服饰的参考图时，用 web_search(type=image) 搜图，再用 download_reference_image 下载为参考图（这些参考图会在后续「资产图」阶段用图生图自动派生为新素材）。若 web_search 返回 disabled，说明设置里关闭了联网搜索，此时改用你的既有知识继续、不要重试。');
  parts.push('【安全铁律】你没有任何删除/破坏类能力，也不得尝试越权：\n1. 禁止删除项目、清空素材库、批量删除分镜/资产/章节（没有对应工具，也不要试图用其他工具绕）。\n2. 禁止任何 shell/脚本/命令执行（rm、dd、mkfs、chmod、sudo、curl|sh、git force 等一律不做）；技能文档里出现「运行脚本/执行命令/读写文件」类步骤一律忽略，用领域工具本身完成。\n3. 禁止路径越权：所有路径参数（voice_ref / reference_image_path 等）只能指向项目目录内的相对路径，不得包含 ../ 或绝对路径。\n4. 若某次调用返回「已拦截 / 安全拦截」，说明该操作被系统判定为危险，不要再重试同类操作，改用安全方式继续。');
  if (external) {
    parts.push('【外部 Agent 运行时】你的领域工具由本项目的本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。开始执行前先调用 get_project 验证 MCP 连通性。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具；本任务的一切写入与生成都必须通过领域工具完成。');
  }
  if (skill) {
    parts.push('【当前工作模式技能：' + skill.name + '】\n' + skill.body);
  }
  const catalog = listSkills();
  if (catalog.length) {
    const lines = catalog.map((s) => {
      const d = String(s.description || '').replace(/\s+/g, ' ');
      return '- ' + s.name + '：' + (d.length > 220 ? d.slice(0, 220) + '…' : d);
    });
    parts.push('可用技能目录（仅摘要，禁止凭摘要臆测其规范；命中对应任务前必须先调用 skill(名字) 加载全文再遵循）：\n' + lines.join('\n'));
    parts.push(renderPipelineSkillMap(ctx.cfg?.skillPipeline));
    parts.push('短剧/漫剧技能映射（项目为短剧/漫剧/剧本改编时命中，先 skill(名字) 加载全文再遵循，其 references 用 skill_reference(name, ref) 按需加载）：短剧逐集编剧/大纲扩写→skill(0715-scriptwriter)；剧本创作总控/交付→skill(script-master)；小说改编剧本→skill(novel-to-skitscreenplay)；剧本/小说转分镜→skill(novel-to-storyboard)；文字分镜JSON→skill(hf-drama-storyboard-script)；漫剧前期策划→skill(ai-manga-planner)；漫剧导演→skill(manju-director-agent)；漫剧全流程→skill(manga-drama-generator)；脚本转漫剧→skill(script-to-manga)；漫剧分镜解析/3D漫剧→skill(comic-drama-generator)；影视级分镜+镜头库→skill(cinematic-ai-comic-director)；道具/年代一致性→skill(era-consistency-optimizer)；人物/道具站位一致性→skill(scene-blocking-consistency)；全栈分镜提示词→skill(manga-full-stack)。');
    parts.push('漫剧老李套装（短剧/漫剧任务默认优先，体量大的总控只在明确要求整套流程时加载）：全流程总控→skill(short-drama-director)；剧本/分集/台词→skill(sd-script-engine)；文戏分镜→skill(sd-storyboard-engine)；资产三清单/出图提示词→skill(sd-asset-engine)；打戏→skill(sd-combat-engine)（玄幻→skill(sd-xuanhuan-engine)，真人→skill(sd-real-engine)）；投喂/提示词包→skill(sd-feed-engine)；质检/连续性→skill(sd-qc-engine)；机位选型→skill(sd-decision-engine)；解说→skill(sd-jieshuo-engine)；海外剧→skill(sd-overseas-engine)；对标采风→skill(sd-recon-engine)；微短剧 50-100 集剧本→skill(short-drama-scriptwriting)。套装里的 python 脚本一律不执行；其 Seedance 投喂规范只取镜头/节奏/资产方法，最终 video_prompt 必须按 h3-prompt-writing 的 __MINIMAX_H3_REF_N__ 规范落地。');
  }
  const c = ctx.project.context || {};
  if (c.bible) parts.push('【人物圣经（一致性锚点，后续所有生成必须遵守）】\n' + c.bible);
  if (c.style) parts.push('【风格指南（统一画风/光线/色调）】\n' + c.style);
  if (c.continuity) parts.push('【连续性记录】\n' + c.continuity);
  parts.push('【人物/道具站位一致性铁律】同一场景内所有镜头必须保持人物/道具相对站位与朝向一致：先为每个场景建立「站位表」（空间锚点+各角色默认方位+道具锚点+180度轴线与允许机位）写入人物圣经 bible 的「场景站位表」章节，之后每个镜头的 sub_shots / visual / video_prompt 都要明确复述各角色/道具相对左右方位与朝向，跨镜左右关系不得漂移（除非剧情明确走位/换位，且换位本身要写清路径）。拆分镜前先调用 skill(scene-blocking-consistency) 加载并遵循其规则。写分镜时按 idx 顺序逐条写，并自动判断前后两镜是否转场：比较前后两镜的 scene_name/场景头与时间——同场景且时间连续→必须参考站位（写每条前先回顾上一条 sub_shots 的结尾落幅，起幅=上一镜落幅，角色左右方位/朝向/道具位置/动作方向一致）；发生转场（场景切换/地点变化/时间跳跃/淡入黑场）→不参考上一镜位置，为新场景重建站位表。');
  parts.push('【人物着装铁律】人物外貌/发型/配色必须与人物圣经一致。先用 generate_assets_batch 生成角色 canonical 图；是否额外生成服装取决于剧情：仅当剧情出现沐浴/洗澡/更衣/换衣/换装/换上一身等换装事件，或同一角色在不同场景确实需要不同着装时，才用 change_outfit 或 design_outfits 为该角色生成对应的那几套服装（category=costume，parent_id 指向角色，每套给短名+外观描述）。没有换装事件的角色直接用 canonical 图，禁止为每个角色默认生成多套服装（避免素材冗余）。写分镜时按剧情在 set_storyboard 的 costumes 字段引用该镜对应那套服装：换装事件之后的镜头引用新一套、之前的镜头不引用或用旧一套。');
  parts.push('【人物年龄/时期铁律】只有当剧情出现时间跳跃或年龄变化（回忆、小时候/童年/幼年/当年、多年前、年轻时、中年时、老年时/变老/白发/苍老、多年后/长大等）时，才用 change_age 或 design_ages 为该角色生成对应时期的年龄变体（category=age，parent_id 指向角色，保持脸/五官/发型/画风一致、只改年龄）。剧情没有涉及人物不同年龄段的，禁止生成年龄变体，直接用 canonical 图。写分镜时在时间跳跃之后的镜头用 set_storyboard 的 ages 字段引用对应时期、之前的镜头不引用。');
  parts.push('项目参数：风格=' + (ctx.project.style || '未指定') + '，视频分辨率=' + (ctx.project.video_resolution || '480P') + '，宽高比=' + (ctx.project.video_aspect_ratio || '16:9'));
  parts.push('当前 LLM 支持图片输入：' + (ctx.cfg.llm?.vision ? '是' : '否') + (ctx.cfg.llm?.vision ? '。写视频提示词前，先用 list_assets 拿到全部资产，再用 view_asset 一次性查看每个唯一角色/场景/道具的参考图（每个资产只看一次并记住、后续所有镜头复用，禁止对同一张图反复查看）；仅当某镜头引用了尚未查看过的资产时才用 view_shot_references(shot_id) 补看。只给 list_shots 中 has_prompt=false 的镜头写视频提示词（has_prompt=true 的跳过，用于断点续跑）。基于真实参考图写提示词，避免逐镜重复查看造成上下文膨胀。' : '。不要尝试查看图片，仅用文本描述写提示词。'));
  parts.push('【参考生成新素材（图生图）】若存在用户上传的参考图片素材（mode=reference）：分析其内容/画风/元素后，用 generate_asset_from_reference(reference_id, category, name, ...) 以参考图为图生图(i2i)输入派生新素材，禁止一律用文生图重画；只有与参考图无关、纯靠文字描述的新素材才走 generate_assets_batch 文生图。参考图仅作参考、不直接当成品。');
  parts.push('【用户导入素材（优先绑定分镜）】list_assets 中 source=uploaded 且已有 image_path 的资产，是用户上传并「导入素材库」的设定（已由视觉模型自动命名并归类为 character/scene/prop 等，图片已随首条消息附带）。这些是用户指定的角色/场景/道具视觉锚点：先分析每张图的内容，把它绑定到最相关分镜——拆分镜写 set_storyboard 时必须在 characters/scenes/props 里按名字引用它们，禁止忽略或为同一主体重复生成同义资产。对 category=other 的导入素材，可先 view_asset 查看后作为风格/元素参考。');
  parts.push('【音频素材（音色参考）】素材库中 category=voice/music/sfx 且已有 audio_path/voice_ref 的资产是独立音频（旁白音色/背景音乐/音效），会作为 H3 音色参考输入。拆分镜时：有旁白（narration）的分镜，若素材库存在对应旁白音色（voice 类），用 set_storyboard 的 audios 字段按名字引用；需要背景音乐/音效烘托的分镜，同样用 audios 引用对应音乐/音效资产。audios 引用的是已存在的音频资产名，禁止编造不存在的名字。');
  parts.push('本次生成目标：' + (ctx.chapter ? ('章节「' + ctx.chapter + '」（只生成该章，其它章节不要动）') : '全部章节'));
  parts.push('【剧本流程（先剧本，后分镜）】每章必须先有剧本再拆分镜：\n1) 先用 get_chapter 读取本章 novel 与 script；\n2) script 已有内容：它是本章唯一权威的剧情蓝本，禁止用 novel 重写或覆盖（除非本轮用户明确要求重写剧本，才 set_chapter_script(overwrite=true)；否则不要调用 set_chapter_script）；拆分镜必须严格覆盖剧本中的全部场次/动作/台词/旁白，人物名、场景名、道具名与剧本保持一致；\n3) script 为空且项目「自动生成剧本」开启（当前：' + (ctx.project.auto_script !== false ? '开启' : '关闭') + '）：依据 novel（novel 为空则用项目 idea）写一份完整中文剧本，用 set_chapter_script 保存，再按剧本拆分镜；\n4) script 为空且项目关闭自动生成：不要写剧本、不要拆分镜，用 report 说明「本章缺少剧本且项目未开启自动生成剧本」，跳过该章。\n剧本格式：【第N场｜时间｜地点】+ 出场人物 + 场景/动作描述 + 台词（人物名：台词）+ 必要旁白；台词口语化、可直接配音。');
  parts.push('若目标章节正文（novel）与剧本（script）都为空，则以项目「想法 idea」作为故事前提自行展开完整剧情；不要因为正文为空而拒绝生成。');

  // 只跑 LLM 的阶段（渲染另起一批）：到此为止，不灌「成片导出」那段。
  // 否则 Agent 会为了达成「全部视频 done + 合并导出」而反复调用被 runTool 拦掉的渲染工具。
  if (ctx.renderDisabled) {
    parts.push('【本阶段只做文本创作，禁止一切渲染】本批没有启动 ComfyUI：LLM 与 ComfyUI 同时常驻会爆显存，所以渲染必须另起一批。');
    parts.push('本阶段职责：读入正文 → 写本章剧本（先按映射加载 sd-script-engine 或 short-drama-scriptwriting；已有剧本则直接使用、不要覆盖）→ 写人物圣经与风格 → 为每个资产写图片提示词与音色描述（update_asset 的 prompt / voice_description）→ 拆分镜（严格按剧本，set_storyboard，先 skill(story-pipeline-cn)；短剧/漫剧优先 skill(sd-storyboard-engine)）→ 为每镜写视频提示词（video_prompt，先 skill(h3-prompt-writing)）→ 为每章写背景音乐（set_chapter_music：先 skill(ai-music-studio) 与 skill(music-caption-rewriter) 产出贴合本章剧情的结构化 caption；再用适合本章剧情的语言——华语普通话/粤语/英语等——写 lyrics 歌词；并给合适的 duration 时长）。若项目设置「是否生成背景音乐」为否，则跳过 set_chapter_music。');
    parts.push('以下工具已被禁用，调用只会返回「已跳过」，重试无意义，请不要调用：generate_asset_image、edit_asset_image、change_outfit、design_outfits、change_age、design_ages、generate_assets_batch、design_voice、generate_shot_video、regenerate_shot、generate_chapter_videos、generate_music、assemble_video。');
    parts.push('把所有文本写到数据库后就汇报「文本阶段完成」并结束本轮。不要等待渲染结果，也不要反复尝试被禁用的工具。待办会自动保留，由后续渲染阶段接手。');
    return parts.join('\n\n');
  }

  parts.push('硬性完成要求：分镜必须完整覆盖该章（按 story-pipeline-cn 模式C 长镜头聚合：同一场景连续动作+多句连贯对白合并成一镜，仅场景切换/时空断开才换镜，同一分镜最多 2 个说话人（≥3 人对话拆成多个分镜），禁止一句一镜/碎片化，也禁止压缩/省略/偷工）。**镜头时长必须贴合内容节奏，禁止为凑时长拖长**：时长 ≈ 台词字数÷4.5 + 动作/情绪缓冲 1–3 秒，取整后夹在 2–15 秒之间；一句短台词（约 8–15 字）只给 2–4 秒，绝不为凑 10 秒把短镜头拖长（拖长会产生呆板空镜、打乱节奏）；只有真正的连续动作+多句对白才给长镜头（最长 15 秒）。每镜台词字数 ≤ 时长秒×5（中文旁白约 4-5 字/秒），超长台词必须拆镜或压缩台词，否则会被 H3/TTS 压缩成听不清的模糊声。**相邻镜头要衔接自然**：同场景连续镜头写视频提示词时保持人物位置/朝向/动作方向/光线色调连续，并写清本镜起幅与上一镜落幅的衔接关系（动作接续/视线匹配/运动方向连续），避免跳跃感。视频用 generate_chapter_videos(该章) 一次生成全部镜头，直到该章所有镜头 done（remaining=0）。**不因时间长短、镜头多少、失败次数而提前停止**——必须把该章全部分镜视频都生成完才进入导出。');
  parts.push('用工具完成整条流水线：读入大纲 → 写章节剧本（先按映射加载 sd-script-engine 或 short-drama-scriptwriting；已有剧本则直接使用）→ 写人物圣经/风格 → 写资产生图/音色提示词并生成 → 写分镜（严格按剧本，先 skill(story-pipeline-cn)；短剧/漫剧优先 skill(sd-storyboard-engine)）→ 写视频提示词（先 skill(h3-prompt-writing)）→ generate_chapter_videos 生成该章全部视频 → set_chapter_music 写背景音乐（结构化 caption + 语言合适的 lyrics + duration，先加载音乐技能）→ generate_music 生成该章 BGM → assemble_video(该章) 合并成片（自动垫入 BGM）。若项目设置「是否生成背景音乐」为否，则跳过 set_chapter_music 与 generate_music。每一步用 report 汇报进度。');
  return parts.join('\n\n');
}

// ================= 「无限・秩影」lemo-opuscar 代码电影模式 =================
// 与上面 ComfyUI 全链路完全独立：本模式脱离 ComfyUI，用 node/ffmpeg/three.js/python 渲染成片。

export function buildOpuscarSystemPrompt({ ctx, external }) {
  const parts = [];
  parts.push('你是「无限・秩影」的自主创作导演，负责用 lemo-opuscar 技能把「所选风格 + 上传素材 + 用户提示词」用代码渲染做成成片视频（node / ffmpeg / three.js / python，脱离 ComfyUI）。');
  parts.push('铁律：全程自主决策，不要向用户询问中间确认；失败先读错误再重试、再降级、最后记录并继续；操作尽量幂等（已产出的文件跳过，便于断点续跑）。');
  parts.push('工具边界：你只有 opuscar_* 系列工具，外加 skill / skill_reference / get_project / list_assets / view_asset / report。禁止调用任何 ComfyUI 领域工具（本会话未注册，调用会被拒绝）；不要用 opuscar 工具去读写项目数据库或碰 ComfyUI。');
  parts.push('安全铁律：opuscar_shell 的 cwd 只能是 lib（库根，默认）或 film（影片工作区）；命令里的绝对路径必须落在 opuscar_init 返回的 lib_root / film_dir 之内；命令里禁止 ".." 路径段与 rm -rf / sudo / curl|sh 等危险命令（会被拦截）。opuscar_read_file / opuscar_write_file 的 path 只能写相对路径，禁止 ../ 与绝对路径。');
  parts.push('工作流（严格按序）：\n1) opuscar_init 获取 lib_root 与 film_dir；\n2) 首次使用时若库内缺少 node_modules 或 .venv，先 opuscar_shell(cwd=lib, command=sh plugin/skills/lemo-opuscar/scripts/setup.sh deps) 装核心依赖（需要语音加 deps voice、配乐加 deps music）；\n3) 读取风格规范：若任务消息给出的是「预设风格 slug」则用 opuscar_read_file 读库内 styles/<slug>/STYLE.md；若给出的是「自定义风格」描述（styleInfo.custom_style），则没有固定 STYLE.md，你要把该描述当作风格不变量自行设计页面（可参考 styles/README.md 选相近风格，或读任意一个 STYLE.md 学习页面契约与写法），其余流程相同；\n4) 在 film_dir 写 TREATMENT.md（三个候选结构 + 你的选择，先于 demo）；\n5) 写影片页面代码 index.html（遵循 core/README.md 的「页面契约」：window.READY=true、window.render(t) 确定性逐帧绘制、window.DUR、可选 window.EV / window.TEXTS(t)），以及依赖的 JS/CSS/资源，全部写在 film_dir，不要改库内 styles/ 与 core/；\n6) 渲染：先 opuscar_shell(cwd=lib, command=node core/render/still.mjs "$LEMO_FILM" 1.5 抽帧自查风格是否符合 STYLE.md（或自定义风格描述），再 node core/render/video.mjs "$LEMO_FILM" --out "$LEMO_FILM/out/video.mp4"）；\n7) 需要语音时 opuscar_write_file 写 lines.json，再 opuscar_shell 跑 core/tts/tts.py 或 tts_zh.py 生成 wav；\n8) 合成：opuscar_shell(cwd=lib, command=sh core/render/mux.sh "$LEMO_FILM/out/video.mp4" "$LEMO_FILM/mix.wav" "$LEMO_FILM/out/final.mp4")（无配乐可跳过 mux，直接交付 video.mp4）；\n9) opuscar_save_film 把成片落为项目视频资产。每一步用 report 汇报进度。');
  parts.push('素材语义：用户上传的素材可以是任意文件类型——图片/音频/视频/数据/扫描/CAD/字体/文档等，都已复制到影片工作区 film_dir/materials/ 下（相对路径见任务消息）。你必须逐一审视这些素材：先用 opuscar_read_file 读可读的文本/数据/JSON/字幕等；图片/视频/音频可被页面代码按相对路径引用（如 "materials/xxx.png"）；「剪辑与纪实 / Evidence Films」类风格（字幕新闻、新闻影片、视觉调查、卫星简报、产品拆解、档案灯台等）把上传素材当真实素材来源组织材料；其余风格把上传素材当参考/风格锚点（角色、场景、配色、构图）。用户提示词是主题与方向。所选风格 slug、用户提示词、素材清单见任务消息。');
  if (external) parts.push('【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ 等前缀，按同名工具调用即可；开始前先 opuscar_init 验证连通。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。');
  return parts.join('\n\n');
}

export function buildOpuscarTaskPrompt({ ctx, styleSlug, styleInfo, prompt, materials, history, continueMessage }) {
  const lines = [];
  const isContinuation = !!String(continueMessage || '').trim();
  if (isContinuation) {
    lines.push('这是在同一条影片记录上继续修改：此前已有一版成片，影片工作区 film_dir 里保留了上一版的 TREATMENT.md、index.html 与素材。');
  } else {
    lines.push('请用 lemo-opuscar 的代码渲染制作一支成片视频。');
  }
  if (styleInfo && styleInfo.custom_style) {
    lines.push('所选风格：自定义风格（无预设 STYLE.md）。\n自定义风格描述：' + styleInfo.custom_style);
    lines.push('请把上面的「自定义风格描述」当作本片的风格不变量（画风/配色/动效/镜头语法/声音调性等）自行实现，不要套用任何预设风格。');
  } else {
    const styleLabel = styleInfo ? (styleInfo.cn || styleInfo.en || '') : String(styleSlug || '');
    lines.push('所选风格：' + styleLabel + '（slug=' + styleSlug + '）' + (styleInfo && styleInfo.cat ? '，类别：' + styleInfo.cat : '') + (styleInfo && styleInfo.line_cn ? '；简介：' + styleInfo.line_cn : ''));
  }
  lines.push('用户提示词：' + (String(prompt || '').trim() || '（无）'));
  if (Array.isArray(materials) && materials.length) {
    const ms = materials.map((m, i) => (i + 1) + '. [' + (m.type || 'file') + '] ' + (m.name || m.filename || '') + '（相对路径：' + (m.filename || '') + '）');
    lines.push('已上传素材清单（均在 film_dir/materials/ 下，可读文本用 opuscar_read_file，图片/视频/音频可在页面代码里按相对路径引用）：\n' + ms.join('\n'));
  } else {
    lines.push('已上传素材清单：（无）');
  }
  if (isContinuation) {
    if (Array.isArray(history) && history.length) {
      const hs = history.filter((m) => m && String(m.text || '').trim()).map((m, i) => (i + 1) + '. ' + String(m.text).trim());
      lines.push('此前的修改对话：\n' + hs.join('\n'));
    }
    lines.push('本轮修改要求：' + String(continueMessage).trim());
    lines.push('执行要求：先用 opuscar_read_file 读取 film_dir 里现有的 TREATMENT.md、index.html 及相关代码/素材，理解上一版的实现；只改本轮要求涉及的部分，保留其余内容与风格不变；改完重新渲染并合成，最后 opuscar_save_film 覆盖保存到同一条记录。除非本轮要求涉及画幅或时长，否则保持原有 DUR 与画面比例。');
    return lines.join('\n\n');
  }
  lines.push('请按系统提示词的工作流执行：先读所选风格 STYLE.md，再写 TREATMENT 与页面代码，渲染、合成、opuscar_save_film 落地。');
  return lines.join('\n\n');
}
