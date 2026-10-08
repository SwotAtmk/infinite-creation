// 共享常量与工具函数（无 React 依赖）

export const CATEGORIES = [
  ['character', '人物'], ['scene', '场景'], ['prop', '道具'], ['costume', '服装'],
  ['voice', '语音'], ['music', '音乐'], ['sfx', '音效'], ['video', '视频'], ['other', '其他'],
];
export const VIDEO_RESOLUTIONS = [['360P', '360P'], ['480P', '480P'], ['720P', '720P'], ['1080P', '1080P'], ['custom', '自定义宽高']];
export const VIDEO_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
export const STYLE_PRESETS = ['真人写实', '国漫', '日系动漫风', 'Q版卡通风', '国风玄幻'];
export const STYLE_CUSTOM = '自定义风格';
export const STYLE_OPTIONS = [...STYLE_PRESETS, STYLE_CUSTOM];

// 下拉选择值 + 自定义文本 -> 最终存储的 style 字符串
export function resolveStyle(sel, custom) {
  return sel === STYLE_CUSTOM ? (custom || '').trim() : (sel || '');
}
// 已存的 style 字符串 -> { sel, custom }，用于编辑回显
export function splitStyle(style) {
  const s = (style || '').trim();
  if (!s) return { sel: '', custom: '' };
  if (STYLE_PRESETS.includes(s)) return { sel: s, custom: '' };
  return { sel: STYLE_CUSTOM, custom: s };
}
export const STATUS_TAG = { done: 'done', failed: 'failed', running: 'running', generating: 'running', pending: '' };

export function fileUrl(projectId, rel) {
  if (!rel) return null;
  return '/files/projects/' + projectId + '/' + rel;
}

// 解析对白里的说话人名单（与后端 dialogueSpeakerNames 逻辑保持一致）
export function dialogueSpeakers(dialogue) {
  if (!dialogue) return [];
  const names = new Set();
  for (const line of String(dialogue).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(.+?)[：:]/);
    if (!m) continue;
    const name = m[1].replace(/[(（][^()（）]*[)）]/g, '').replace(/[，。、,;；!！?？.·]+$/g, '').trim();
    if (name) names.add(name);
  }
  return [...names];
}