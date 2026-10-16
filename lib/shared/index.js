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
  '360P': 0.25, '480P': 0.5, '720P': 1, '768P': 1, '1080P': 2, '2K': 2, '4K': 4,
};
// 自定义分辨率：不查表，宽高直接取自项目设置（project.video_width / video_height），
// 此时 ResolutionSelector 节点变成孤立节点并被剪掉。
export const VIDEO_RESOLUTION_CUSTOM = 'custom';
// 界面下拉给出的标签。1080P/2K/4K 只留在映射表里不进下拉（能写能存、兼容历史数据，但不给选项）：
// 已核对过上游节点（ResolutionSelector 是 ComfyUI 核心节点 comfy_extras/nodes_resolution.py，
// megapixels 为 Float，只有 min=0.1/max=16 的范围校验、无 step 校验），2/4 是合法入参；
// 挡在下拉外是**成本**考虑——2MP/4MP 就是 1080p/4K 级出片，AMD 单卡上没有意义（作者的下拉本来也止于 768P）。
export const VIDEO_RESOLUTION_OPTIONS = ['360P', '480P', '720P', '768P', VIDEO_RESOLUTION_CUSTOM];
// 可解析的分辨率标签（映射表键 + 自定义），写入校验用；空串另算（= 继承项目设置）。
export const VIDEO_RESOLUTIONS = [...Object.keys(VIDEO_RESOLUTION_MP), VIDEO_RESOLUTION_CUSTOM];
export const VIDEO_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];

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
};

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
export function filterReferenceImages(list, targetChapterIdSet) {
  return (list || []).filter((r) => {
    if (targetChapterIdSet == null) return true;
    return targetChapterIdSet.has(r.chapter_id);
  });
}

// —— 硬件模式：一键切换「英伟达原版工作流」与「AMD + GGUF 适配工作流」 ——
// 定义在此（纯数据 + 纯函数，无 node 依赖），后端配置解析与设置页即时预览共用同一份，
// 避免前后端各存一份预设导致漂移。
export const HW_MODES = ['nvidia', 'amd'];
export const HW_PRESETS = {
  nvidia: { t2i: 'krea2_hyperreal_t2i', i2i: 'qwen_image_edit_2511_i2i', r2v: 'minimax_h3_r2v', tts: 'qwen3_tts_voice_design', music: 'minimax_music3' },
  amd: { t2i: 'qwen_image_2_1_t2i_gguf', i2i: 'qwen_image_2_1_i2i_gguf', r2v: 'minimax_h3_r2v_gguf', tts: 'qwen3_tts_voice_design_gguf', music: 'minimax_music3' },
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
const PRESET_OPTIONAL_KEYS = new Set(['music']);

// wf 是否与指定模式的预设一致：预设里的键必须齐全且相等（后加的可选键允许缺），
// 且不允许出现预设之外的自定义键（有自定义键 = 用户改过，不随模式切换）。
function matchesPreset(wf, mode) {
  const p = HW_PRESETS[mode];
  if (!p || !wf || typeof wf !== 'object') return false;
  const presetKeys = Object.keys(p);
  if (Object.keys(wf).some((k) => !presetKeys.includes(k))) return false;
  return presetKeys.every((k) => (wf[k] === undefined ? PRESET_OPTIONAL_KEYS.has(k) : wf[k] === p[k]));
}

// 一组 workflows 恰好等于某个硬件预设时返回该模式，否则 null（用于模式推断）
export function presetModeOf(wf) {
  return HW_MODES.find((m) => matchesPreset(wf, m)) || null;
}

// 该 workflows 映射是否恰好等于某一模式的预设（是 → 说明用户没自定义，可随模式切换）
export function isPresetWorkflows(wf) {
  return HW_MODES.some((m) => matchesPreset(wf, m));
}

// —— ComfyUI 服务类型与 RunningHub 云端 ——
export const COMFY_PROVIDERS = [
  { id: 'native', label: '原生ComfyUI接口' },
  { id: 'runninghub', label: '云端RunningHub接口' },
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
