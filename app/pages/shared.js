// 共享常量与工具函数（无 React 依赖）
import { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTION_CUSTOM, VIDEO_RESOLUTION_OPTIONS, ASSET_CATEGORIES } from '../../lib/shared/index.js';

// 资产分类下拉（素材库分组 Tab + 新建/编辑素材的分类选择）与写入端共用一份值域：
// 之前这里手写清单且漏了 age，导致「年龄/时期」变体在素材库里既建不出、也改不过去
// （界面下拉没有这项），而 Agent 工具与后端都能写它 —— 下拉与真实值域漂移。
export const CATEGORIES = ASSET_CATEGORIES.map((c) => [c.id, c.label]);
// 分辨率 / 宽高比的取值域统一来自 lib/shared（工作流映射表与写入校验共用同一份），
// 这里只做「值 → 显示名」的展示层映射，避免下拉与映射表各写一份而彼此漂移。
export const VIDEO_RESOLUTIONS = VIDEO_RESOLUTION_OPTIONS.map((v) => [v, v === VIDEO_RESOLUTION_CUSTOM ? '自定义宽高' : v]);
export const VIDEO_RATIOS = VIDEO_ASPECT_RATIOS;
export const STYLE_PRESETS = ['真人写实', '动漫', '国漫', '日系动漫风', '卡通', 'Q版卡通风', '国风玄幻'];
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

// HeroUI Select 受控辅助：selectedKeys 传 Set，onSelectionChange 回传 Set
export function selectKeys(v) {
  return (v == null || v === '') ? new Set() : new Set([String(v)]);
}
export function pickKey(keys) {
  if (keys == null) return '';
  if (keys === 'all') return '';
  if (keys instanceof Set) return keys.size ? String([...keys][0]) : '';
  if (Array.isArray(keys)) return keys.length ? String(keys[0]) : '';
  return String(keys);
}

// 状态字符串 -> HeroUI Chip 颜色
export function statusColor(status) {
  if (!status) return 'default';
  if (status === 'done') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'generating') return 'warning';
  return 'default';
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