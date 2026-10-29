// 单一事实来源：常量与纯函数直接复用主仓库 lib/shared，避免工作室与老界面各写一份而漂移。
import { VIDEO_RESOLUTION_OPTIONS, VIDEO_RESOLUTION_CUSTOM, VIDEO_ASPECT_RATIOS } from '@shared';

export {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABEL,
  ASSET_CATEGORY_IDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTION_CUSTOM,
  VIDEO_RESOLUTION_OPTIONS,
  HW_MODES,
  HW_PRESETS,
  HW_DEFAULT_FREE,
  hardwareMode,
  isPresetWorkflows,
  comfyBaseUrl,
  RUNNINGHUB_TIERS,
  nameMatches,
  isReferenceImageName,
  REFERENCE_IMAGE_EXTS,
  REFERENCE_IMAGE_MAX_BYTES,
  isVariantAssetCategory,
  SHOT_STATUS,
  PROJECT_TYPES,
  PROJECT_TYPE_LABEL,
} from '@shared';

// 下拉展示用：值 → 显示名，与主界面保持同一份值域（不把 1080P/2K/4K 放进下拉）
export const VIDEO_RESOLUTION_ITEMS = VIDEO_RESOLUTION_OPTIONS.map((v) => ({
  value: v,
  label: v === VIDEO_RESOLUTION_CUSTOM ? '自定义宽高' : v,
}));
export const VIDEO_RATIO_ITEMS = VIDEO_ASPECT_RATIOS.map((r) => ({ value: r, label: r }));

export const STYLE_PRESETS = ['真人写实', '动漫', '国漫', '日系动漫风', '卡通', 'Q版卡通风', '国风玄幻'];
export const STYLE_CUSTOM = '自定义风格';
export const STYLE_OPTIONS = [...STYLE_PRESETS, STYLE_CUSTOM];

export function resolveStyle(sel, custom) {
  return sel === STYLE_CUSTOM ? (custom || '').trim() : sel || '';
}

export function splitStyle(style) {
  const s = (style || '').trim();
  if (!s) return { sel: '', custom: '' };
  if (STYLE_PRESETS.includes(s)) return { sel: s, custom: '' };
  return { sel: STYLE_CUSTOM, custom: s };
}

// 对白说话人（与后端 dialogueSpeakerNames 同一口径）
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

export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
