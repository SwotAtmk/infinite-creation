// 共享常量与工具函数（无 React 依赖）

export const CATEGORIES = [
  ['character', '人物'], ['scene', '场景'], ['prop', '道具'], ['costume', '服装'],
  ['voice', '语音'], ['music', '音乐'], ['sfx', '音效'], ['video', '视频'], ['other', '其他'],
];
export const VIDEO_RESOLUTIONS = [['360P', '360P'], ['480P', '480P'], ['720P', '720P'], ['1080P', '1080P'], ['custom', '自定义宽高']];
export const VIDEO_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
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