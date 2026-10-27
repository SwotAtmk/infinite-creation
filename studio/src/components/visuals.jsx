import {
  Box,
  Clapperboard,
  Download,
  Film,
  Hourglass,
  Image as ImageIcon,
  Layers,
  Mic2,
  Mountain,
  Music4,
  Package,
  Palette,
  RefreshCw,
  Shirt,
  Sparkles,
  UserRound,
  Video,
  Volume2,
  Wand2,
} from 'lucide-react';
import { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTION_OPTIONS, VIDEO_RESOLUTION_CUSTOM } from '../lib/shared.js';

// 比例图标：外框按真实宽高比绘制，竖屏/方屏一眼可辨
export function RatioIcon({ ratio = '16:9', size = 16, className }) {
  const [w, h] = String(ratio)
    .split(':')
    .map((n) => Number(n) || 0);
  if (!w || !h) return null;
  const ar = w / h;
  const maxW = 13;
  const maxH = 11;
  let rw;
  let rh;
  if (ar >= maxW / maxH) {
    rw = maxW;
    rh = maxW / ar;
  } else {
    rh = maxH;
    rw = maxH * ar;
  }
  const x = (16 - rw) / 2;
  const y = (16 - rh) / 2;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x={x} y={y} width={rw} height={rh} rx="1.6" stroke="currentColor" strokeWidth="1.25" />
      <rect x={x + 1.8} y={y + 1.8} width={Math.max(0, rw - 3.6)} height={Math.max(0, rh - 3.6)} rx="0.8" fill="currentColor" opacity="0.22" />
    </svg>
  );
}

const RES_LEVEL = { '360P': 1, '480P': 2, '720P': 3, '768P': 3, '1080P': 4, '2K': 4, '4K': 5, custom: 2 };

// 分辨率图标：外框内的高亮区域随档位增大，360P → 4K 有直观的「画面变大」感
export function ResolutionIcon({ resolution = '480P', size = 16, className }) {
  const level = RES_LEVEL[resolution] || 2;
  const isCustom = resolution === VIDEO_RESOLUTION_CUSTOM;
  const inset = Math.max(0.9, 5.4 - level * 0.9);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect
        x="1.3"
        y="2.4"
        width="13.4"
        height="9.4"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray={isCustom ? '2 1.4' : undefined}
      />
      <rect
        x={1.3 + inset}
        y={2.4 + inset * 0.7}
        width={13.4 - inset * 2}
        height={9.4 - inset * 1.4}
        rx="0.7"
        fill="currentColor"
        opacity="0.28"
      />
      <path d="M6 14.2h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

const CATEGORY_ICONS = {
  character: UserRound,
  scene: Mountain,
  prop: Package,
  costume: Shirt,
  age: Hourglass,
  voice: Mic2,
  music: Music4,
  sfx: Volume2,
  video: Video,
  other: Box,
  audio: Volume2,
};

export function AssetCategoryIcon({ category, size = 13, className }) {
  const Icon = CATEGORY_ICONS[category] || Box;
  return <Icon size={size} className={className} />;
}

const JOB_ICONS = {
  create: Sparkles,
  regenerate: RefreshCw,
  'asset-image': ImageIcon,
  'voice-design': Mic2,
  costume: Shirt,
  age: Hourglass,
  stage: Layers,
  'chapter-video': Film,
  llm: Wand2,
  export: Download,
  music: Music4,
  'music-apply': Music4,
};

export function JobTypeIcon({ type, size = 13, className }) {
  const Icon = JOB_ICONS[type] || Clapperboard;
  return <Icon size={size} className={className} />;
}

export function StyleIcon({ size = 13, className }) {
  return <Palette size={size} className={className} />;
}

// Select 用的下拉项：label + 视觉图标
export const RESOLUTION_SELECT_ITEMS = VIDEO_RESOLUTION_OPTIONS.map((v) => ({
  value: v,
  label: v === VIDEO_RESOLUTION_CUSTOM ? '自定义宽高' : v,
  icon: <ResolutionIcon resolution={v} />,
}));

export const RATIO_SELECT_ITEMS = VIDEO_ASPECT_RATIOS.map((r) => ({
  value: r,
  label: r,
  icon: <RatioIcon ratio={r} />,
}));

export function MetaItem({ icon: Icon, children, className }) {
  return (
    <span className={'inline-flex items-center gap-1 ' + (className || '')}>
      {Icon ? <Icon size={11} className="shrink-0 opacity-70" /> : null}
      {children}
    </span>
  );
}

export function RatioMeta({ ratio }) {
  if (!ratio) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <RatioIcon ratio={ratio} size={11} />
      {ratio}
    </span>
  );
}

export function ResolutionMeta({ resolution, width, height }) {
  const label = resolution === VIDEO_RESOLUTION_CUSTOM && width ? 'custom ' + width + '×' + height : resolution;
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <ResolutionIcon resolution={resolution} size={11} />
      {label}
    </span>
  );
}
