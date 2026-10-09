import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// —— 剧本生成 ——
export function buildScriptMessages({ idea, novel, style }) {
  const source = novel?.trim()
    ? '以下是用户提供的小说文本：\n' + novel.trim()
    : '以下是用户提供的故事想法：\n' + (idea?.trim() || '（无）');
  const styleLine = style?.trim() ? '画面风格：' + style.trim() + '。所有视觉元素（角色、场景、道具）需统一遵循此风格。' : '';
  const system = [
    '你是一名专业的漫剧（动态漫画/有声漫画）编剧与分镜师。',
    '根据用户提供的小说文本或故事想法，创作一部适合制作成漫剧的完整剧本。',
    styleLine,
    '只输出严格合法的 JSON，结构如下（字段名不可更改）：',
    JSON.stringify({
      title: '剧名',
      logline: '一句话梗概',
      characters: [{ name: '角色名', appearance: '外貌、服装、气质等视觉描述，用于文生图', voice: '声音特征描述，用于配音参考' }],
      scenes: [{ name: '场景名', description: '场景环境、光线、风格描述，用于文生图' }],
      props: [{ name: '道具名', description: '道具外观描述，用于文生图' }],
      storyboard: [{ shot: 1, scenes: ['场景名'], duration: 12, characters: ['角色名'], props: ['道具名'], sub_shots: '0-3秒（近景、近距离、正前方平视、固定机位）：画面内容描述；运镜：静止；背景声音描述；台词：人物名+台词。3-7秒（中景、中距离、正前方平视、跟拍）：画面内容描述；背景声音描述；台词：人物名+台词。7-12秒（全景、远距离、俯视、缓推）：画面内容描述；背景声音描述；台词：人物名+台词。' }],
    }, null, 2),
    '要求：',
    '- characters 1~5 个，每个都有 appearance 和 voice；',
    '- scenes 1~5 个；',
    '- storyboard 里的每个分镜就是一个「场景（主分镜/长镜头）」：尽量少拆分镜，把同一场景里连续的动作/对话/走位合并进一个长镜头，duration 建议 8~15 秒（最长 15 秒），避免 3~5 秒的短镜头碎剪；',
    '- 每个主分镜的 characters 可包含多个角色、scenes 可包含 1~2 个场景、props 可包含多个道具（用名称数组表示）；',
    '- 每个主分镜用 sub_shots 描述「子分镜时间轴」：把整个场景按时间连续拆成多个子分镜（如 0-3秒、3-7秒、7-12秒），子分镜时间首尾相接、各子分镜时长之和等于该主分镜 duration；每个子分镜写清括号内的镜头描述（景别/距离/角度/机位）、画面内容、运镜、背景声音、台词（人物名+台词）；',
    '- 台词口语化，适合配音，不出现动作标注；',
    '- 只输出 JSON，不要任何多余文字或解释。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: source },
  ];
}

const QWEN_IMAGE_GUIDE = [
  '1. 结构化优于叙事化：按「主体 → 环境/背景 → 光照/材质/色调/视角等细节」分类描述，避免流水账长句；',
  '2. 描述优先级：先写主体核心特征，再写环境设定，最后补充细节（材质、光影、色调、镜头视角）；',
  '3. 简洁胜于冗长：1~3 句话最佳，去掉冗余修饰；',
  '4. 明确镜头视角：特写/中景/全景、正面/侧面/背面、平视/俯视/仰视等要写清楚；',
  '5. 画面内不得出现任何文字、字幕、水印、logo、标语、签名；',
  '6. 必须输出负向提示词 negative_prompt：通用排除 blurry, low quality, pixelated, distorted, watermark, text, subtitles, caption, letters, words, text overlay, signature, logo, oversaturated, artificial, plastic-looking；人物类额外排除 extra fingers, deformed hands, mutated hands, fused fingers, plastic skin, over-smoothed。',
].join('\n');

let _guideCache = null;
function loadQwenGuide() {
  if (_guideCache !== null) return _guideCache;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'Qwen-Image-2512_提示词实战指南.md'), 'utf8');
    _guideCache = raw.split('\n').filter((l) => !l.trimStart().startsWith('![Image](') && !l.trimStart().startsWith('>') && !l.trimStart().startsWith('### 5.2')).join('\n').trim();
    if (!_guideCache) _guideCache = '';
  } catch { _guideCache = ''; }
  return _guideCache;
}

export function buildAssetPromptMessages({ type, name, description, scriptSummary, style }) {
  const typeLabel = { character: '角色/人物', scene: '场景', prop: '道具' }[type] || '对象';
  const typeRule = type === 'character'
    ? '- 这是一张「角色设定三视图」：必须同时包含 ①脸部特写（突出五官、发型、神态、气质）②全身三视图（正面、侧面、背面三个视角），同一角色外貌/服装/配色完全一致，简洁浅色背景，横向布局；'
    : type === 'scene'
      ? '- 这是场景环境图：突出环境氛围、空间透视、光线与风格，画面完整可作背景；'
      : '- 这是道具图：白色背景（纯白底），画面中只出现该道具本身，不要出现人物、场景、文字或其他任何元素，只描述道具的形状/材质/细节等特征；';
  const guideText = loadQwenGuide() || QWEN_IMAGE_GUIDE;
  const user = [
    '请为一个漫剧项目里的' + typeLabel + '编写文生图提示词。',
    '类型：' + typeLabel,
    '名称：' + name,
    '设定描述：' + (description || '（无，请根据名称与剧本自行合理发挥）'),
    '剧本摘要：' + (scriptSummary || '（无）'),
    '要求：',
    typeRule,
    '- 画面风格：' + (style?.trim() || '适合漫剧的精美二次元/国漫插画风格') + '（保持与项目整体风格一致）；',
    '- 严格参考系统提示词中的《Qwen-Image-2512 提示词实战指南》编写：结构化分类描述（主体→环境→细节）、简洁（80~150 字）、明确镜头视角；',
    '- 同时给出负向提示词 negative_prompt；',
    '- 纯中文，prompt 直接可喂给文生图模型；',
    '- 只输出 JSON：{"prompt":"...","negative_prompt":"..."}。',
  ].join('\n');
  return [
    { role: 'system', content: '你是一名专业的 AI 绘画提示词专家，擅长为 Qwen-Image-2512 文生图模型编写高质量中文提示词。\n\n以下是《Qwen-Image-2512 提示词实战指南》，你必须严格参考其中的原则来编写提示词：\n\n<Qwen-Image-2512 实战指南>\n' + guideText + '\n</Qwen-Image-2512 实战指南>\n\n只输出 JSON：{"prompt":"...","negative_prompt":"..."}。' },
    { role: 'user', content: user },
  ];
}

export function fallbackAssetPrompt({ type, name, description, style }) {
  const s = style?.trim() || '适合漫剧的精美二次元/国漫插画风格';
  const d = description?.trim() || '';
  const noText = '；画面中不得出现任何文字、字幕、水印、logo、标语、签名';
  const noTextNeg = 'text, subtitles, caption, letters, words, watermark, logo, signature, text overlay';
  if (type === 'character') {
    return {
      prompt: '角色设定三视图：' + name + (d ? '，' + d : '') + '；脸部特写突出五官/发型/神态/气质；全身正面、侧面、背面三视图，外貌与服装配色完全一致；简洁浅色背景，横向布局' + noText + '；画面风格：' + s,
      negative_prompt: 'blurry, low quality, pixelated, ' + noTextNeg + ', extra fingers, deformed hands, mutated hands, fused fingers, plastic skin, over-smoothed',
    };
  }
  if (type === 'scene') {
    return {
      prompt: '场景：' + name + (d ? '，' + d : '') + '；突出环境氛围、空间透视、光线与风格，画面完整可作背景' + noText + '；画面风格：' + s,
      negative_prompt: 'blurry, low quality, pixelated, ' + noTextNeg + ', oversaturated, artificial, plastic-looking',
    };
  }
  return {
    prompt: '道具：' + name + (d ? '，' + d : '') + '；纯白背景，画面中只出现该道具本身，无人物、无文字、无其它元素' + noText + '；突出形状、材质、细节；画面风格：' + s,
    negative_prompt: 'blurry, low quality, pixelated, ' + noTextNeg + ', person, text, extra elements',
  };
}

// Qwen-Image 2.1 / Krea2 文生图「人物素材」的固定构图约束：
// 白底 + 左侧 1/3 面部特写 + 右侧 2/3 全身三视图，多视角比例严格一致。
export const CHARACTER_T2I_LAYOUT_CONSTRAINT = '左侧1/3 区域为超大高清上半身正面面部特写，右侧 2/3 区域整齐排布角色3张全身三视图，包含角色的正面 、侧面及背面三个维度的全身站姿视图。背景为纯白色背景。人物身材比例好。\n视觉对齐： 所有角度的比例必须严格一致，确保角色身高、五官位置、服装褶皱等人物形态在不同视角下完美契合。';

export function buildStoryboardMessages(script, style) {
  const styleLine = style?.trim() ? '画面风格：' + style.trim() + '。' : '';
  return [
    { role: 'system', content: '你是一名漫剧分镜师。根据剧本，输出分镜列表 JSON：{"storyboard":[{"shot":1,"scenes":["场景名"],"duration":12,"characters":["角色名"],"props":["道具名"],"sub_shots":"0-3秒（近景、近距离、正前方平视、固定机位）：画面内容；运镜：静止；背景声音；台词：人物名+台词。..."}]}。每个分镜就是一个场景（主分镜/长镜头），尽量少拆分镜、把同一场景连续动作合并，duration 建议 8~15 秒（最长 15 秒）；characters/scenes/props 用名称数组；sub_shots 是把整个场景按时间连续拆成多个子分镜的画面提示词，子分镜时间首尾相接、时长之和等于 duration。' + styleLine + '只输出 JSON。' },
    { role: 'user', content: '剧本如下：\n' + JSON.stringify(script, null, 2) },
  ];
}

// —— MiniMax H3 视频提示词（兜底）——
// 仅在 LLM 尚未通过 h3-prompt-writing 技能写出 shot.video_prompt 时使用的最小兜底：
// 按 H3 规范用 __MINIMAX_H3_REF_N__ 逐个引用参考素材，注入风格/角色/场景一致性描述。
export function fallbackVideoPrompt({ references, style, characterDesc, sceneDesc, subShots, camera, visual, dialogue, characterName }) {
  const parts = [];
  if (style) parts.push('画面风格：' + style);
  (references || []).forEach((ref, i) => {
    parts.push('__MINIMAX_H3_REF_' + (i + 1) + '__' + (ref.label || '参考'));
  });
  if (characterDesc) parts.push('角色保持一致：' + characterDesc);
  if (sceneDesc) parts.push('场景保持一致：' + sceneDesc);
  if (subShots) parts.push('分镜时间轴：' + subShots);
  else {
    if (camera) parts.push('镜头：' + camera);
    if (visual) parts.push(visual);
    if (dialogue) parts.push((characterName || '角色') + '说道“' + dialogue + '”');
  }
  parts.push('画面中不得出现任何文字、字幕、水印、logo、标语');
  return parts.join('，');
}

// —— 对白说话人解析与参考音频约束 ——
// 单个分镜最多允许的说话人数量（≥3 人对话必须拆成多个分镜）
export const MAX_SPEAKERS_PER_SHOT = 2;
// 单个分镜参考素材中最多允许的音频段数（MiniMax H3 节点 maxAudioVideo 上限）
export const MAX_AUDIO_REFS = 3;

// 从对白字符串中提取所有说话人名字：每行「人物：台词」，取第一个全/半角冒号前的人名，
// 剥离舞台提示括号（如「林默（站在路口）」）与句尾标点；无冒号行（画面/旁白描述）跳过。
export function dialogueSpeakerNames(dialogue) {
  if (!dialogue) return [];
  const names = new Set();
  for (const line of String(dialogue).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(.+?)[：:]/);
    if (!m) continue;
    const name = m[1]
      .replace(/[(（][^()（）]*[)）]/g, '')   // 剥离舞台提示（站在路口）/(望着远处)
      .replace(/[，。、,;；!！?？.·]+$/g, '') // 剥离句尾标点
      .trim();
    if (name) names.add(name);
  }
  return [...names];
}

// 解析子分镜时间轴里最大的「结束秒数」
export function parseSubShotEndSeconds(text) {
  if (!text) return null;
  let max = null;
  const re = /(\d+(?:\.\d+)?)\s*[-~—–至到]\s*(\d+(?:\.\d+)?)\s*秒/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = parseFloat(m[2]);
    if (max === null || end > max) max = end;
  }
  return max;
}

export function validateSubShots(duration, subShots) {
  const maxEnd = parseSubShotEndSeconds(subShots);
  if (maxEnd !== null && maxEnd > (parseFloat(duration) || 0)) {
    return '子分镜提示词的时间（' + maxEnd + ' 秒）超过了总时长（' + (parseFloat(duration) || 0) + ' 秒）';
  }
  return null;
}
