// 共享常量与类型约定（纯数据，无运行时依赖）

// 资产分类（用户要求：人物/场景/道具/语音等统一整理）
export const ASSET_CATEGORIES = [
  { id: 'character', label: '人物', labelEn: 'Character' },
  { id: 'scene', label: '场景', labelEn: 'Scene' },
  { id: 'prop', label: '道具', labelEn: 'Prop' },
  { id: 'costume', label: '服装', labelEn: 'Costume' },
  { id: 'age', label: '年龄/时期', labelEn: 'Age' },
  { id: 'voice', label: '语音', labelEn: 'Voice' },
  { id: 'music', label: '音乐', labelEn: 'Music' },
  { id: 'sfx', label: '音效', labelEn: 'SFX' },
  { id: 'video', label: '视频', labelEn: 'Video' },
  { id: 'other', label: '其他', labelEn: 'Other' },
];
export const ASSET_CATEGORY_IDS = ASSET_CATEGORIES.map((c) => c.id);
export const ASSET_CATEGORY_LABEL = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.id, c.label]));

// 参考图上传的白名单与上限：references 路由（后端校验）与 ReferencePicker（前端选择器）
// 共用一份。此前前端按 `file.type.startsWith('image/')` 过滤、后端只认这五种扩展名，
// 于是 bmp/avif/svg/tiff 能选中、上传后才 400；而没有 MIME type 的合法 png 又被前端静默丢掉。
export const REFERENCE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export function isReferenceImageName(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  const i = n.lastIndexOf('.');
  // i > 0：'.png' 这类「只有扩展名」的文件名不是图片（后端 path.extname('.png') === '' 会 400），
  // 前端放行只会让用户上传到那张才失败。
  return i > 0 && REFERENCE_IMAGE_EXTS.includes(n.slice(i));
}

// 「挂在角色下的变体」分类：服装 / 年龄。这类素材只有 parent_id 指向角色才有意义 ——
// refs.js 只按 parent_id 把它们映射到角色（镜头里有该角色时才用它替换角色参考图），
// tools.js 也只把「带 parent_id 的变体」算作该角色已有服装/年龄。
// 因此写入端必须要求 parent_id（否则素材库里看得见、分镜能引用、生成时被静默忽略）。
export const VARIANT_ASSET_CATEGORIES = ['costume', 'age'];
export function isVariantAssetCategory(category) {
  return VARIANT_ASSET_CATEGORIES.includes(category);
}

// —— 素材上传的媒体判定（assets/[aid]/upload 路由与单测共用一份）——
// 判定顺序：分类优先（voice/music/sfx 是音频、video 是视频），再看扩展名。
// gif 算「图片」：<video> 元素根本放不出 gif（素材卡用 <video> 渲染 video_path），
// references 上传路由也把 gif 当图片；归到 video_path 会让素材既没有 image_path
//（拿去做参考图时被跳过）又显示成打不开的播放器。
export const AUDIO_ASSET_CATEGORIES = ['voice', 'music', 'sfx'];
export const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;
export const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v)$/i;

export function uploadMediaKind({ category = '', ext = '' } = {}) {
  if (category === 'video' || VIDEO_EXT_RE.test(ext)) return 'video';
  if (AUDIO_ASSET_CATEGORIES.includes(category) || AUDIO_EXT_RE.test(ext)) return 'audio';
  return 'image';
}

// —— 角色名匹配（refs.js 的音色归属、tools.js 的换装/年龄归属、分镜面板展示 共用一份）——
// 对白说话人与角色名必须是「规范化后精确相等」。中文名里「明 / 小明」「李 / 小李」这类
// 互为子串的名字很常见，用 includes 双向包含匹配会把没说话的角色也判成说话人：
// 错挂他人音色（还可能挤掉 MAX_AUDIO_REFS 名额）、分镜面板也显示错角色的试听。
// 规范化只剥离「身份后缀/舞台提示」与分隔符，保留「小明（少年）」这种 canonical 名
// 与对白说话人「小明」的兼容（dialogueSpeakerNames 也会剥掉括号部分）。
export function normalizeName(n) {
  return String(n == null ? '' : n)
    .replace(/[(（][^()（）]*[)）]/g, '')
    .replace(/[·•・.。]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function nameMatches(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return !!na && na === nb;
}

// 文本是否「真正提到」某角色名：排除「该次出现只是同场更长角色名的一部分」。
// 例：同场有「小明」时，角色「明」不应因文本里出现「小明」而被判为被提及——
// 否则 autoResolveOutfits / autoResolveAges 会给「明」错生成一套不属于他的服装/年龄变体
//（每条都是一次真提交的图生图，既白烧 GPU 又给成片挂错参考）。
export function textMentions(text, name, allNames = []) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return false;
  const t = String(text == null ? '' : text);
  if (!t.includes(n)) return false;
  // 「同场更长角色名」在文本里的**书面形式**：canonical 名常带身份后缀（「小明（少年）」），
  // 而分镜文本里通常只写「小明」——只拿原名去文本里找必然找不到，
  // 于是短名「明」又被误判成「被提到」，白跑一次图生图并挂错参考（这正是本函数要解决的问题）。
  // 所以两种形式都算候选：原名，以及剥掉后缀/分隔符后的规范化名。
  const forms = [];
  for (const x of allNames || []) {
    const raw = String(x == null ? '' : x);
    if (!raw || raw === n || raw.length <= n.length || !raw.includes(n)) continue;
    forms.push(raw);
    const norm = normalizeName(raw);
    if (norm && norm !== raw && norm.length > n.length) forms.push(norm);
  }
  if (!forms.length) return true;
  const covers = (ln, start, end) => {
    // 逐次查找（含重叠）：只要有一次出现完整覆盖本次出现，就算被更长名吞掉
    let li = t.indexOf(ln);
    while (li !== -1) {
      if (li <= start && li + ln.length >= end) return true;
      li = t.indexOf(ln, li + 1);
    }
    return false;
  };
  let idx = t.indexOf(n);
  while (idx !== -1) {
    const end = idx + n.length;
    if (!forms.some((ln) => covers(ln, idx, end))) return true;
    idx = t.indexOf(n, end);
  }
  return false;
}

// 项目上下文（人物圣经 / 风格指南 / 连续性记录）的键。
// 单一事实来源：内置 Agent 的 save_context 与 PUT /api/projects/:id/context 都按它校验
// （两边各写一份时曾出现「Agent 接受任意 key、路由 400」的口径漂移）。
export const CONTEXT_KEYS = ['bible', 'style', 'continuity'];

// 分镜状态
export const SHOT_STATUS = {
  pending: '待生成',
  generating: '生成中',
  done: '完成',
  failed: '失败',
};

// 后台任务状态
export const JOB_STATUS = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
};

export const JOB_TYPES = ['create', 'regenerate', 'import_workflow'];

export const SKILL_SOURCES = ['bundled', 'installed', 'generated'];

export const WORKFLOW_KINDS = ['t2i', 'i2i', 'r2v', 'custom'];

// —— 视频分辨率 / 宽高比（单一事实来源）——
// 三处消费方全部引用这里，不再各写一份：工作流映射表（lib/core/workflow-specs.js）、
// 写入校验（lib/core/shot-write.js）、界面下拉（app/pages/shared.js）。
// 实测踩过的坑：下拉里有 360P/768P 而映射表没有 → 标签被原样写进 ComfyUI 的 megapixels 参数，
// 提交时才报错；映射表里有 1080P/2K/4K 而下拉里选不到 —— 两边各写一份就必然漂移。
//
// 键 = 项目/分镜上存的标签，值 = ResolutionSelector 的 megapixels 目标（面积；节点按宽高比折算，
// 再把宽高取 32 的倍数，见 ComfyUI_MiniMaxH3_Director 的 resolution_from_selector）。
export const VIDEO_RESOLUTION_MP = {
  '360P': 0.25, '480P': 0.5, '540P': 0.5, '720P': 1, '768P': 1, '1080P': 2, '2K': 2, '4K': 4,
};
// 自定义分辨率：不查表，宽高直接取自项目设置（project.video_width / video_height），
// 此时 ResolutionSelector 节点变成孤立节点并被剪掉。
export const VIDEO_RESOLUTION_CUSTOM = 'custom';
// 界面下拉给出的标签。540P/1080P/2K/4K 已支持：≤768P 走普通 r2v，>768P 走二次采样超分
// （见 R2V_UPSCALE_*）；ResolutionSelector（GGUF/AMD 路径）只按 megapixels 取值，2/4 均合法。
export const VIDEO_RESOLUTION_OPTIONS = ['360P', '480P', '540P', '720P', '768P', '1080P', '2K', '4K', VIDEO_RESOLUTION_CUSTOM];
// 可解析的分辨率标签（映射表键 + 自定义），写入校验用；空串另算（= 继承项目设置）。
export const VIDEO_RESOLUTIONS = [...Object.keys(VIDEO_RESOLUTION_MP), VIDEO_RESOLUTION_CUSTOM];
// 二次采样超分（MiniMax H3 Easy + Sigma Latent Upscale）：>768P 时首遍按 768P 生成，
// 再用 mode.scale 做线性超分。scale 是高度方向线性倍率（768*1.4≈1080、*1.88≈1440、*2.81≈2160）。
export const R2V_UPSCALE_BASE_RESOLUTION = '768P';
export const R2V_UPSCALE_SCALE = {
  '1080P': 1.4,
  '2K': 1.88,
  '4K': 2.81,
};
export const VIDEO_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
// 分镜视频生成模式（Agent 面向）：reference=全能参考（多图+音视频）、image=图生视频（1 张图）、
// first_last=首尾帧（首帧+尾帧 2 张图）、text=文生视频（不连媒体）、digital_human=数字人（预留，不对接业务）。
// 空串 = 未指定（auto，由 inferVideoMode 确定性推断兜底）。
export const VIDEO_MODES = ['reference', 'image', 'first_last', 'text', 'digital_human'];
// 模式 → 中文标签（后端日志与前端分镜类型徽章共用一份，避免漂移）
export const VIDEO_MODE_LABELS = {
  reference: '全能参考',
  image: '图生视频',
  first_last: '首尾帧',
  text: '文生视频',
  digital_human: '数字人',
};

// 项目类型（首页左侧菜单：不同类型对应不同工作台页面，Agent 类型 = 现有全链路流水线）
export const PROJECT_TYPES = ['agent', 'digital_human', 'image', 'video', 'music', 'tts', 'tts_clone', 'opuscar', 'novel'];
export const PROJECT_TYPE_LABEL = {
  agent: 'Agent无限创作',
  digital_human: '数字人',
  image: '图片生成',
  video: '视频生成',
  music: '音乐生成',
  tts: '音色设计',
  tts_clone: '音色克隆',
  opuscar: '无限・秩影',
  novel: '无限・卷轴',
};

// 自定义分辨率的画布宽高约束（video_resolution=custom 时直接用作 width/height）。
// 0 = 未设置（生成端取 `Number(x) || 默认`）。写进 5 这类值不会当场报错，却让之后的每一镜在渲染阶段
// 才炸，所以写入端（db 层 Projects.create/update）就要挡；界面 EditProject 的 min=64 与下限对齐。
// 上限 4096 是防呆（单卡出片）；宽高在生成节点侧还会按 32 的倍数取整，故此处不强制 32 对齐。
export const VIDEO_DIM_MIN = 64;
export const VIDEO_DIM_MAX = 4096;

// openclaude 在模型输出达到 max_tokens 上限（finish_reason='length'）或上游流停滞时，
// 会向文本流合成一条「[Response truncated — reached length limit or upstream stalled…]」提示。
// 识别它用于应用层的截断/停滞看门狗（见 lib/agent/openclaude-agent.js）。
export const TRUNCATION_MARKER = /Response truncated/i;
export function isTruncatedText(text) {
  return typeof text === 'string' && TRUNCATION_MARKER.test(text);
}

// —— Agent 运行看门狗（防「模型输出被截断后任务永远卡住」）——
// 背景：本地大模型易在接近输出上限时被截断；openclaude 的续写循环（continuation nudge，
// 上限 20 次）每次都要重新等本地模型生成几十分钟，或上游彻底停止推流，导致 job 永远
// running、界面一直显示停止按钮。两层兜底：
//   1) 停滞超时：无消息到达超过 STALL_MS（且不在工具执行窗口），判定上游停滞，主动中断；
//   2) 截断熔断：连续 MAX_TRUNC_STREAK 条消息都只是截断提示、无任何实质进展（无工具调用
//      且无正常文本），判定陷入截断循环，主动中断。
export const AGENT_WATCHDOG = {
  // 无消息到达的间隔上限（毫秒）。本地 27B 单轮生成一般远小于此值；可通过 config.generation.agentStallMinutes 覆盖。
  STALL_MS: 20 * 60 * 1000,
  // 连续纯截断（无进展）熔断阈值
  MAX_TRUNC_STREAK: 3,
  // 停滞守护定时器间隔（毫秒）：即使 for await 阻塞在等待消息，也能及时中断
  CHECK_INTERVAL_MS: 15 * 1000,
};

// 从 SDK 消息中提取分类（纯函数，便于单测）：
//  hasToolUse  —— 消息含 tool_use 块（进入工具执行窗口）
//  hasTrunc    —— 消息含截断提示文本
//  hasPlainText—— 消息含非截断的正常文本
//  toolUseCount  —— 本条消息里的 tool_use 块数量（assistant 消息）
//  toolResultCount—— 本条消息里的 tool_result 块数量（user 消息）
// 工具结果（tool_result）出现在 user 消息里，所以这里不限定 msg.type 必须是 assistant，
// 这样才能准确统计「还有多少工具在运行」，避免把渲染窗口误判为已结束。
export function classifyAgentMsg(msg) {
  if (!msg || !Array.isArray(msg.message?.content)) {
    return { hasToolUse: false, hasTrunc: false, hasPlainText: false, toolUseCount: 0, toolResultCount: 0 };
  }
  let hasToolUse = false;
  let hasTrunc = false;
  let hasPlainText = false;
  let toolUseCount = 0;
  let toolResultCount = 0;
  for (const b of msg.message.content) {
    if (!b) continue;
    if (b.type === 'tool_use') { hasToolUse = true; toolUseCount += 1; }
    else if (b.type === 'tool_result') { toolResultCount += 1; }
    else if (b.type === 'text' && typeof b.text === 'string') {
      if (isTruncatedText(b.text)) hasTrunc = true;
      else if (b.text.trim()) hasPlainText = true;
    }
  }
  return { hasToolUse, hasTrunc, hasPlainText, toolUseCount, toolResultCount };
}

const STALL_MSG = '模型输出长时间停滞（疑似上游断开），已自动中止任务。';

// 消息驱动的状态更新（每条消息到达时调用一次）。state 形如
// { lastAt: number, pendingTools: number, truncStreak: number }；
// 返回 { next, halted }，halted 非空表示应中止任务并抛出该错误信息。
// stallMs 允许按模型实际速度覆盖默认阈值（config.generation.agentStallMinutes）。
export function watchdogStep(state, msg, now = Date.now(), stallMs = AGENT_WATCHDOG.STALL_MS) {
  const { MAX_TRUNC_STREAK } = AGENT_WATCHDOG;
  // 停滞判定：当前没有待执行的工具，且距上一条消息超过上限 → 上游停滞
  if (state.pendingTools <= 0 && now - state.lastAt > stallMs) {
    return { next: state, halted: STALL_MSG };
  }
  // 分类本条消息并推进状态
  const { hasToolUse, hasTrunc, hasPlainText, toolUseCount, toolResultCount } = classifyAgentMsg(msg);
  // 待执行工具计数：tool_use 增、tool_result 减，不为负。
  // 一条 assistant 消息可能同时含多个 tool_use（如 report + generate_chapter_videos），
  // 它们会各自返回 tool_result；用计数而非布尔值，避免「快工具先返回」把窗口误判为已结束，
  // 导致仍在运行的慢工具（> STALL_MS 的渲染）被停滞看门狗误杀。
  const pendingTools = Math.max(0, state.pendingTools + toolUseCount - toolResultCount);
  const next = { lastAt: now, pendingTools, truncStreak: 0 };
  // 只有「纯截断提示」才累计（既无工具调用也无正常文本）；中间有任何实质进展即归零
  if (hasTrunc && !hasToolUse && !hasPlainText) {
    next.truncStreak = state.truncStreak + 1;
    if (next.truncStreak >= MAX_TRUNC_STREAK) {
      return { next, halted: '模型输出连续被截断（达到长度上限或上游停滞）且无进展，已自动中止任务。可调大模型 max_tokens 或精简上下文后重试。' };
    }
  }
  return { next, halted: null };
}

// 纯停滞检查（由守护定时器调用，不依赖消息到达）：仍有待执行工具时不判停滞。
export function watchdogStallCheck(state, now = Date.now(), stallMs = AGENT_WATCHDOG.STALL_MS) {
  if (state.pendingTools > 0) return null;
  return now - state.lastAt > stallMs ? STALL_MSG : null;
}

// 项目目录下的分类子目录名（相对 data/projects/<id>/assets/<category>）
export const PROJECT_ASSET_SUBDIRS = {
  character: 'characters',
  scene: 'scenes',
  prop: 'props',
  costume: 'costumes',
  age: 'ages',
  voice: 'voice',
  music: 'music',
  sfx: 'sfx',
  video: 'videos',
  other: 'other',
};

// 上传体积上限（字节）。上传路由把整个请求体读进内存（req.arrayBuffer），没有上限时
// 一个误选的大文件（界面上传框不限类型）或局域网内任意客户端就能把进程撑爆 OOM——
// 默认监听 0.0.0.0，不能只靠前端自觉。按落库后的媒体类型分三档。
export const UPLOAD_MAX_BYTES = {
  image: 20 * 1024 * 1024,   // 20MB：设定图/参考图，正常尺寸远小于此
  audio: 100 * 1024 * 1024,  // 100MB：音色样本 / 配乐 / 音效
  video: 500 * 1024 * 1024,  // 500MB：视频素材（成片导出不走这条路由）
  file: 500 * 1024 * 1024,   // 500MB：任意其它文件（数据/扫描/CAD/字体/文档等），供 Agent 按需使用
};

// 技能包 zip 的体积上限。installSkillsFromZip 同样把整个请求体读进内存（且解压也在内存里），
// 没有上限时一个大文件就能把进程撑爆 OOM；技能包正常只有几十 KB～几 MB，20MB 足够宽。
export const SKILL_ZIP_MAX_BYTES = 20 * 1024 * 1024;

// 流水线配置包（IC_CONFIG.json + 引用的全部技能）zip 体积上限：比单技能包更宽，允许打包多个技能。
export const PIPELINE_ZIP_MAX_BYTES = 50 * 1024 * 1024;

// —— 流水线技能编排节点（单一事实来源）——
// 后端提示词生成（lib/agent/agent-loop.js）与 Studio 编辑器共用同一份元数据。
// 每个节点 = 一组有序技能列表 + fallback（是否允许自动匹配其它技能）。
// defaultSkills 即「系统默认预设」：对齐现有流水线的实际技能映射（写剧本→拆分镜→出图→出片→配乐），
// 完整型技能（如剧本套装/分镜套装）排在通用技能之后，对不上时仍可自动匹配。
export const SKILL_PIPELINE_NODES = [
  {
    id: 'novel',
    label: '生成小说',
    desc: '网文大纲 · 逐章正文',
    defaultSkills: ['webnovel-writing'],
  },
  {
    id: 'script',
    label: '生成剧本',
    desc: '写章节剧本',
    defaultSkills: ['sd-script-engine', 'short-drama-scriptwriting', 'novel-to-skitscreenplay'],
  },
  {
    id: 'character',
    label: '人物素材',
    desc: '角色立绘 / 提示词',
    defaultSkills: ['image-prompt-writing', 'sd-asset-engine'],
  },
  {
    id: 'prop',
    label: '道具素材',
    desc: '道具定妆 / 提示词',
    defaultSkills: ['image-prompt-writing', 'sd-asset-engine'],
  },
  {
    id: 'scene',
    label: '场景素材',
    desc: '场景氛围 / 提示词',
    defaultSkills: ['image-prompt-writing', 'sd-asset-engine', 'era-consistency-optimizer'],
  },
  {
    id: 'costume',
    label: '换装',
    desc: '服装变体',
    defaultSkills: ['image-prompt-writing', 'sd-asset-engine'],
  },
  {
    id: 'age',
    label: '年龄分级',
    desc: '年龄 / 时期变体',
    defaultSkills: ['image-prompt-writing', 'sd-asset-engine'],
  },
  {
    id: 'voice',
    label: '配音·音色',
    desc: '人物音色样本',
    defaultSkills: ['tts-voice-design'],
  },
  {
    id: 'storyboard',
    label: '生成分镜脚本',
    desc: '拆分镜 · 站位一致性',
    defaultSkills: ['story-pipeline-cn', 'sd-storyboard-engine', 'scene-blocking-consistency'],
  },
  {
    id: 'video_prompt',
    label: '视频提示词',
    desc: '逐镜出片提示词',
    defaultSkills: ['h3-prompt-writing', 'video-cinematography'],
  },
  {
    id: 'music',
    label: '生成背景音乐',
    desc: '音乐描述/歌词/时长',
    defaultSkills: ['ai-music-studio', 'music-caption-rewriter'],
  },
  {
    id: 'pipeline',
    label: '总流水线',
    desc: '整体编排',
    defaultSkills: ['novel-to-video', 'short-drama-director'],
  },
];
export const SKILL_PIPELINE_NODE_IDS = SKILL_PIPELINE_NODES.map((n) => n.id);
export const SKILL_PIPELINE_NODE_MAP = Object.fromEntries(SKILL_PIPELINE_NODES.map((n) => [n.id, n]));

// 由节点元数据推导默认 skillPipeline 段（config.js 与前端回退共用）。
export function defaultSkillPipeline() {
  return { nodes: Object.fromEntries(SKILL_PIPELINE_NODES.map((n) => [n.id, { skills: [...n.defaultSkills], fallback: true }])) };
}

// 文生图宽高比 -> [宽, 高]（32 的倍数，兼容 Qwen-Image）
export const RATIO_SIZES = {
  '1:1': [1024, 1024],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1152, 768],
  '2:3': [768, 1152],
  '21:9': [1344, 576],
};
export const RATIO_LIST = Object.keys(RATIO_SIZES);
export function ratioToSize(ratio) {
  return RATIO_SIZES[ratio] || RATIO_SIZES['16:9'];
}

// 视频像素尺寸：分辨率标签（megapixels 目标，与 ResolutionSelector 同一张表）+ 宽高比 → [宽, 高]。
// 只给没有 ResolutionSelector 的视频工作流（hyperflow t2v/i2v/flf2v）用，宽高直写采样节点。
// 先按面积求出宽、对齐到 32，再由对齐后的宽推高（两个方向各自对齐会把宽高比拉歪）。
export function videoSizeFor(resolution, ratio = '16:9') {
  const mp = VIDEO_RESOLUTION_MP[resolution] ?? VIDEO_RESOLUTION_MP['720P'];
  const [rw, rh] = String(ratio || '16:9').split(':').map(Number);
  const r = rw > 0 && rh > 0 ? rw / rh : 16 / 9;
  const snap = (v) => Math.max(32, Math.round(v / 32) * 32);
  const w = snap(Math.sqrt(mp * 1e6 * r));
  return [w, snap(w / r)];
}

// 工作流规格（WorkflowRunner 的驱动描述，技能工厂也产出同结构）
// roles: 语义角色 -> { node, field }
// media: 参考素材（视频类工作流）如何绑定；无则省略
// outputs: 输出节点 class_type 列表，用于在 history 中收集结果
export const WORKFLOW_SPEC_SCHEMA = {
  id: 'string, 唯一 id',
  kind: 't2i|i2i|r2v|custom',
  name: '显示名',
  description: '用途说明',
  sourceFile: 'workflows/ 下的模板文件名',
  roles: {
    positive_prompt: '{ node, field }',
    negative_prompt: '{ node, field }',
    width: '{ node, field }',
    height: '{ node, field }',
    seed: '{ node, field }',
    seconds: '{ node, field }',          // 视频时长
    resolution: '{ node, field }',        // 视频分辨率
    aspect_ratio: '{ node, field }',      // 视频宽高比
    image: '{ node, field }',             // 图生图参考图
    filename_prefix: '{ node, field }',   // 输出前缀
  },
  media: {
    targetNode: '承载 media_N 的节点 id',
    mediaField: "字段名前缀，默认 'media_'",
    typeField: "字段名前缀，默认 'media_type_'",
    loaders: '{ image: {class,field}, audio: {...}, video: {...} }',
    reusePool: '{ image: [已有节点id...], audio: [...], video: [...] }',
    maxImages: '图片上限',
    maxAudioVideo: '音视频上限',
  },
  outputs: ['SaveImage', 'SaveVideo'],
  fixed: '{ 角色名: 值 }，规格自带的输入，调用方不必传（如免转录克隆的 x_vector_only）',
  prune: ['要删掉的模板节点 id（占位参考图、用不上的链）'],
};

// —— TTS 音色性别/年龄推断（兜底层） ——
// 音色性别必须在 voice_description 里显式给出；缺失时 Qwen3-TTS 会自由发挥
//（训练样本分布偏年轻女声），导致「男主变女声、年龄不符」。资产没有声音画像
//（voice_desc）时，从名称/描述推断性别年龄段，拼出基础音色描述；推断不出返回 ''，
// 由调用方决定是给中性描述还是跳过（批量阶段应跳过并提示，不静默出烂音色）。
const VB_MALE = /男|公子|少侠|剑客|大叔|老汉|老翁|老伯|爷爷|父亲|哥哥|先生|侠客|将军|帝王|皇上|王爷|师尊|修士|道士/;
const VB_FEMALE = /女|小姐|姑娘|少女|仙子|公主|皇后|夫人|姐姐|奶奶|婆婆|老妪|娘|妹妹|女神|妖姬|王妃|太太|侍女/;
const VB_AGE_OLD = /4[0-9]岁|5[0-9]岁|6[0-9]岁|7[0-9]岁|8[0-9]岁|9[0-9]岁|老年|老人|老妪|老翁|老伯|花甲|古稀|爷爷|奶奶|婆婆|白发|苍老/;
const VB_AGE_MID = /2[0-9]岁|3[0-9]岁|青年|中年|大叔|御姐|姐姐|哥哥|母亲|父亲|妈妈|爸爸|壮年/;
const VB_AGE_YOUNG = /1[0-9]岁|少年|少女|小孩|孩子|幼年|萝莉|正太|豆蔻|及笄|童/;

export function inferVoiceBaseline(name, description) {
  const src = String(name || '') + '。' + String(description || '');
  const male = VB_MALE.test(src);
  const female = VB_FEMALE.test(src);
  // 中性词性冲突（如「男主角的女友」）时宁可保守成未识别
  const gender = male !== female ? (male ? '男' : '女') : '';
  let age = '';
  if (VB_AGE_OLD.test(src)) age = '老年';
  else if (VB_AGE_MID.test(src)) age = '青年';
  else if (VB_AGE_YOUNG.test(src)) age = '少年';
  if (!gender) return '';
  if (gender === '男') {
    if (age === '老年') return '老年男性，嗓音低沉沙哑，苍老有岁月感，语速偏慢';
    if (age === '少年') return '少年男性，嗓音清亮偏嫩，语速轻快，青春有活力';
    return age === '青年' ? '青年男性，嗓音低沉浑厚，中低音域，沉稳有磁性' : '青年男性，嗓音低沉浑厚，沉稳';
  }
  if (age === '老年') return '老年女性，嗓音苍老温厚，慈祥平淡';
  if (age === '少年') return '少女音，嗓音清亮甜美，青春灵动';
  return age === '青年' ? '青年女性，嗓音清亮柔和，温婉不失力量' : '青年女性，嗓音清亮柔和';
}

// 参考图章节过滤（纯函数）：list 为 reference_images 行数组；targetChapterIdSet 为 null 表示「生成全部章节」。
// 参考素材只按章节归属；无目标章返回全量，指定章节只保留目标章。
// 带 shared 标记的参考图（创建时拆成多章上传）在所有章节都生效，不按 chapter_id 过滤。
export function filterReferenceImages(list, targetChapterIdSet) {
  return (list || []).filter((r) => {
    if (targetChapterIdSet == null) return true;
    return !!r.shared || targetChapterIdSet.has(r.chapter_id);
  });
}

// —— 小说拆分章节（创建项目时自动把长篇小说拆成多章）——
// 参考 .trae/documents/FullText.php 的解析方案：
//   去不可见字符 → 按行切段落（trim、丢空行）→ 移除「目录」区块 → 识别一级章节标题 →
//   无标题时把整段累加到阈值再落章（绝不切断段落），单段本身超阈值才按字符切块。
// 单章字符数（可调常量）：无章节标题且全文超过该值时按段落累计拆成多章。
export const FALLBACK_CHAPTER_CHARS = 6000;

// 不可见字符（零宽 / 双向控制 / BOM）：等价 PHP removeInvisibleCharacters。
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

// 一级章节标题 token：中文「第X章/回/卷/节/集/部/篇」或英文「Chapter N」，须在行首（允许前导空白）。
// 只认一级标题：一、/ 1.1 /（一）/ 1. / 图N / 表N 等论文式多级序号不作为章节边界。
const CHAPTER_HEADING_RE = /^\s*(第[一二三四五六七八九十百千万零两0-9]+[章节回卷集部篇]|chapter\s+\d+)/i;

// 目录标题行：「目录 / 目 录 / Contents / Table of Contents」
const TOC_HEAD_RE = /^(目\s*录|contents|table\s+of\s+contents)$/i;
// 目录条目的页码尾巴：阿拉伯数字、罗马数字、「- 12 -」、「12-15」
const TOC_PAGE_SUFFIX_RE = /(?:^|\s|[.\t…·-])(\d+|[IVXLC]+|-\s*\d+\s*-|\d+\s*-\s*\d+)$/i;
const TOC_MAX_ENTRY_CHARS = 60;
const TOC_SCAN_LINES = 200; // 只在前 200 行内找「目录」，避免正文中偶然出现的同名词误伤

// 统一换行、去不可见字符、逐行 trim、丢空行（等价 PHP processImpl 的预处理）。
function normalizeNovelLines(novel) {
  return String(novel == null ? '' : novel)
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_RE, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function isHeadingLine(line) {
  return CHAPTER_HEADING_RE.test(line);
}

// 目录条目：章节标题行、「标题 + 页码」行，或目录里「标题一行、页码一行」的纯页码行。
function looksLikeTocEntry(line) {
  if (!line || line.length > TOC_MAX_ENTRY_CHARS) return false;
  if (/^(\d+|[IVXLC]+)$/i.test(line)) return true;
  if (isHeadingLine(line)) return true;
  if (!TOC_PAGE_SUFFIX_RE.test(line)) return false;
  // 去掉页码后必须还剩文字，避免把纯符号行当成条目
  return /\p{L}/u.test(line.replace(TOC_PAGE_SUFFIX_RE, ''));
}

// 章节标题 token（去空白小写，用于判断目录与正文里的同一章）
function headingToken(line) {
  const m = line.match(CHAPTER_HEADING_RE);
  return m ? m[1].replace(/\s+/g, '').toLowerCase() : '';
}

// 移除 txt 自带的目录区块（含「目录」行）：
// 连续 ≥2 条目录条目才认定；一旦出现「已在目录里出现过的章节标题」即视为目录结束、正文重新开始
// （目录与正文都以「第一章」开头是最常见的排版），因此只删目录本身，不会吞掉正文首个标题。
function stripTocBlock(lines) {
  const headIdx = lines.slice(0, TOC_SCAN_LINES).findIndex((l) => TOC_HEAD_RE.test(l));
  if (headIdx < 0) return lines;
  const seen = new Set();
  let end = headIdx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!looksLikeTocEntry(line)) break;
    const token = headingToken(line);
    if (token && seen.has(token)) break;
    if (token) seen.add(token);
    end += 1;
  }
  if (end - (headIdx + 1) < 2) return lines;
  return [...lines.slice(0, headIdx), ...lines.slice(end)];
}

// 单段本身超过阈值：没有可切分的换行，只能按字符等分（PHP splitLongEnSection 的思路）。
function splitLongParagraph(line, maxChars) {
  const chunks = [];
  for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
  return chunks;
}

// 段落累计落章（PHP processImpl 的累计策略）：整段累加到 ≥ maxChars 才落一章，
// 因此永远不会切断段落（章长允许略超阈值）；单段超阈值时先落已有缓冲，再切块单独成章。
function packByParagraphs(lines, maxChars) {
  const out = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    if (!buf.length) return;
    out.push({ title: '第' + (out.length + 1) + '章', novel: buf.join('\n') });
    buf = [];
    size = 0;
  };
  for (const line of lines) {
    if (line.length >= maxChars) {
      flush();
      for (const chunk of splitLongParagraph(line, maxChars)) {
        out.push({ title: '第' + (out.length + 1) + '章', novel: chunk });
      }
      continue;
    }
    buf.push(line);
    size += line.length;
    if (size >= maxChars) flush();
  }
  flush();
  return out;
}

// 把小说文本拆成 [{ title, novel }] 列表；输入为空返回 []。
// 规则：① 识别到 ≥2 个一级章节标题 → 按标题切分（标题取标题 token，正文为标题行之后到下一标题行之前）；
//       ② 否则全文 <= fallbackChars → 单章「第1章」；
//       ③ 否则按段落累计到 fallbackChars 再落章（不切断段落）。
// 标题重复时追加「·(2)」等后缀，保证标题唯一（shots.chapter 按标题归属）。
export function splitNovelIntoChapters(novel, { fallbackChars = FALLBACK_CHAPTER_CHARS } = {}) {
  const n = Math.max(1, Number(fallbackChars) || FALLBACK_CHAPTER_CHARS);
  let lines = normalizeNovelLines(novel);
  if (!lines.length) return [];
  lines = stripTocBlock(lines);
  const text = lines.join('\n');

  const headingIdx = [];
  lines.forEach((line, i) => { if (isHeadingLine(line)) headingIdx.push(i); });

  if (headingIdx.length < 2) {
    if (text.length <= n) return [{ title: '第1章', novel: text }];
    return packByParagraphs(lines, n);
  }

  const preface = lines.slice(0, headingIdx[0]).join('\n').trim();
  const seen = new Map();
  const out = [];
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h];
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length;
    let body = lines.slice(start + 1, end).join('\n').trim();
    if (!body) continue; // 只有标题没有正文（多为残留的目录/分隔行）→ 不成章
    if (h === 0 && preface) body = preface + '\n\n' + body;
    const m = lines[start].match(CHAPTER_HEADING_RE);
    let title = (m ? m[1] : lines[start]).trim();
    const c = seen.get(title) || 0;
    seen.set(title, c + 1);
    if (c > 0) title = title + '·(' + (c + 1) + ')';
    out.push({ title, novel: body });
  }
  // 章节全被判定为空（极端情况）时退回单章全文，避免创建出 0 章
  return out.length ? out : [{ title: '第1章', novel: text }];
}

// —— 硬件模式：一键切换「英伟达原版工作流」与「AMD + GGUF 适配工作流」 ——
// 定义在此（纯数据 + 纯函数，无 node 依赖），后端配置解析与设置页即时预览共用同一份，
// 避免前后端各存一份预设导致漂移。
export const HW_MODES = ['nvidia', 'amd'];
export const HW_PRESETS = {
  nvidia: { t2i: 'krea2_hyperreal_t2i', i2i: 'qwen_image_edit_2511_i2i', r2v: 'minimax_h3_r2v', tts: 'qwen3_tts_voice_design', tts_clone: 'qwen3_tts_voice_clone', music: 'minimax_music3' },
  amd: { t2i: 'qwen_image_2_1_t2i_gguf', i2i: 'qwen_image_2_1_i2i_gguf', r2v: 'minimax_h3_r2v_gguf', tts: 'qwen3_tts_voice_design_gguf', tts_clone: 'qwen3_tts_voice_clone_noasr', music: 'minimax_music3' },
};
// 各模式下「生成维护」的默认显存释放次数：AMD Dynamic VRAM 连续生成会累积退化、需定期 /free；N 卡默认关闭。
export const HW_DEFAULT_FREE = { nvidia: 0, amd: 3 };

export function hardwareMode(cfg) {
  return HW_MODES.includes(cfg?.hardware?.mode) ? cfg.hardware.mode : 'nvidia';
}

// 后加入预设的键：更早版本的 config.json 里没有它（当时的 workflows 只有 t2i/i2i/r2v/tts），
// 仍必须认成「用的就是该模式预设」，否则模式推断会退化成 nvidia —— 实测踩坑：
// 整套 AMD 预设因缺 music 键被判为自定义映射 → mode 变 nvidia → AMD 专属保护（preflight 的
// CK 缺陷与显存余量判定）失效、默认显存释放次数变 0。
const PRESET_OPTIONAL_KEYS = new Set(['music', 'tts_clone']);
// 预设里换过 id 的键（老配置仍整套用着该模式预设）：只在模式推断时认，
// 不参与「可覆盖」判定 —— 否则用户显式选回老工作流、保存再加载会被预设悄悄改回去。
const PRESET_LEGACY_IDS = { amd: { tts_clone: ['qwen3_tts_voice_clone'] } };

// wf 是否与指定模式的预设一致：预设里的键必须齐全且相等（后加的可选键允许缺），
// 且不允许出现预设之外的自定义键（有自定义键 = 用户改过，不随模式切换）。
function matchesPreset(wf, mode, allowLegacyIds = false) {
  const p = HW_PRESETS[mode];
  if (!p || !wf || typeof wf !== 'object') return false;
  const presetKeys = Object.keys(p);
  if (Object.keys(wf).some((k) => !presetKeys.includes(k))) return false;
  return presetKeys.every((k) => {
    if (wf[k] === undefined) return PRESET_OPTIONAL_KEYS.has(k);
    if (wf[k] === p[k]) return true;
    return allowLegacyIds && (PRESET_LEGACY_IDS[mode]?.[k] || []).includes(wf[k]);
  });
}

// 一组 workflows 恰好等于某个硬件预设时返回该模式，否则 null（用于模式推断）
export function presetModeOf(wf) {
  return HW_MODES.find((m) => matchesPreset(wf, m, true)) || null;
}

// 该 workflows 映射是否恰好等于某一模式的预设（是 → 说明用户没自定义，可随模式切换）
export function isPresetWorkflows(wf) {
  return HW_MODES.some((m) => matchesPreset(wf, m));
}

// —— ComfyUI 服务类型与 RunningHub 云端 ——
export const COMFY_PROVIDERS = [
  { id: 'native', label: '原生ComfyUI接口' },
  { id: 'runninghub', label: '云端渲染接口' },
];
export const RUNNINGHUB_TIERS = [
  { id: 'standard', label: 'Standard版' },
  { id: 'plus', label: 'Plus版' },
];
// RunningHub 标准 OpenAPI 的固定服务域名（仅展示用，实际请求走 runninghub.js）
export const RUNNINGHUB_API_HOST = 'https://www.runninghub.cn';
// 由配置派生最终 ComfyUI 服务地址（展示用）：RunningHub 走标准 OpenAPI 固定域名
export function comfyBaseUrl(cfg) {
  const c = cfg?.comfyui || {};
  if (c.provider === 'runninghub') return RUNNINGHUB_API_HOST;
  return c.baseUrl || 'http://127.0.0.1:8188';
}

// 启动日志/展示用：对 RunningHub 的 apiKey 脱敏，避免在终端明文泄露完整密钥
export function maskComfyBaseUrl(cfg) {
  const c = cfg?.comfyui || {};
  if (c.provider === 'runninghub') {
    const key = String(c.apiKey || '').trim();
    if (!key) return RUNNINGHUB_API_HOST;
    const masked = key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : '****';
    return RUNNINGHUB_API_HOST + '（apiKey: ' + masked + '）';
  }
  return comfyBaseUrl(cfg);
}
