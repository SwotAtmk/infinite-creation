// 共享常量与类型约定（纯数据，无运行时依赖）

// 资产分类（用户要求：人物/场景/道具/语音等统一整理）
export const ASSET_CATEGORIES = [
  { id: 'character', label: '人物', labelEn: 'Character' },
  { id: 'scene', label: '场景', labelEn: 'Scene' },
  { id: 'prop', label: '道具', labelEn: 'Prop' },
  { id: 'costume', label: '服装', labelEn: 'Costume' },
  { id: 'voice', label: '语音', labelEn: 'Voice' },
  { id: 'music', label: '音乐', labelEn: 'Music' },
  { id: 'sfx', label: '音效', labelEn: 'SFX' },
  { id: 'video', label: '视频', labelEn: 'Video' },
  { id: 'other', label: '其他', labelEn: 'Other' },
];
export const ASSET_CATEGORY_IDS = ASSET_CATEGORIES.map((c) => c.id);
export const ASSET_CATEGORY_LABEL = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.id, c.label]));

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
//  hasToolUse  —— assistant 消息含 tool_use 块（进入工具执行窗口）
//  hasTrunc    —— assistant 消息含截断提示文本
//  hasPlainText—— assistant 消息含非截断的正常文本
export function classifyAgentMsg(msg) {
  if (!msg || msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) {
    return { hasToolUse: false, hasTrunc: false, hasPlainText: false };
  }
  let hasToolUse = false;
  let hasTrunc = false;
  let hasPlainText = false;
  for (const b of msg.message.content) {
    if (!b) continue;
    if (b.type === 'tool_use') hasToolUse = true;
    else if (b.type === 'text' && typeof b.text === 'string') {
      if (isTruncatedText(b.text)) hasTrunc = true;
      else if (b.text.trim()) hasPlainText = true;
    }
  }
  return { hasToolUse, hasTrunc, hasPlainText };
}

const STALL_MSG = '模型输出长时间停滞（疑似上游断开），已自动中止任务。';

// 消息驱动的状态更新（每条消息到达时调用一次）。state 形如
// { lastAt: number, sawToolUse: boolean, truncStreak: number }；
// 返回 { next, halted }，halted 非空表示应中止任务并抛出该错误信息。
// stallMs 允许按模型实际速度覆盖默认阈值（config.generation.agentStallMinutes）。
export function watchdogStep(state, msg, now = Date.now(), stallMs = AGENT_WATCHDOG.STALL_MS) {
  const { MAX_TRUNC_STREAK } = AGENT_WATCHDOG;
  // 停滞判定：上一条消息未开启工具窗口，且距上一条消息超过上限 → 上游停滞
  if (!state.sawToolUse && now - state.lastAt > stallMs) {
    return { next: state, halted: STALL_MSG };
  }
  // 分类本条消息并推进状态
  const { hasToolUse, hasTrunc, hasPlainText } = classifyAgentMsg(msg);
  const next = { lastAt: now, sawToolUse: hasToolUse, truncStreak: 0 };
  // 只有「纯截断提示」才累计（既无工具调用也无正常文本）；中间有任何实质进展即归零
  if (hasTrunc && !hasToolUse && !hasPlainText) {
    next.truncStreak = state.truncStreak + 1;
    if (next.truncStreak >= MAX_TRUNC_STREAK) {
      return { next, halted: '模型输出连续被截断（达到长度上限或上游停滞）且无进展，已自动中止任务。可调大模型 max_tokens 或精简上下文后重试。' };
    }
  }
  return { next, halted: null };
}

// 纯停滞检查（由守护定时器调用，不依赖消息到达）：工具执行窗口不判停滞。
export function watchdogStallCheck(state, now = Date.now(), stallMs = AGENT_WATCHDOG.STALL_MS) {
  if (state.sawToolUse) return null;
  return now - state.lastAt > stallMs ? STALL_MSG : null;
}

// 项目目录下的分类子目录名（相对 data/projects/<id>/assets/<category>）
export const PROJECT_ASSET_SUBDIRS = {
  character: 'characters',
  scene: 'scenes',
  prop: 'props',
  costume: 'costumes',
  voice: 'voice',
  music: 'music',
  sfx: 'sfx',
  video: 'videos',
  other: 'other',
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
