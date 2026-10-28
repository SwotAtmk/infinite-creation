import { useRef } from 'react';
import clsx from 'clsx';
import { FileAudio, Film, Image as ImageIcon, UploadCloud } from 'lucide-react';
import { useDropFiles } from '../lib/hooks.js';
import { ASSET_CATEGORY_LABEL } from '../lib/shared.js';
import { Modal } from './overlays.jsx';
import { fileUrl } from '../lib/format.js';
import { Badge } from './ui.jsx';

export function FileDrop({ onFiles, accept, multiple = false, title = '拖拽文件到这里', hint, icon: Icon = UploadCloud, compact = false, className }) {
  const inputRef = useRef(null);
  const { over, bind } = useDropFiles((files) => onFiles(multiple ? files : files.slice(0, 1)));
  return (
    <div
      {...bind}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
      className={clsx(
        'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-all duration-200',
        compact ? 'px-4 py-4' : 'px-6 py-7',
        over
          ? 'border-[color-mix(in_srgb,var(--accent)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
          : 'border-[var(--line-strong)] bg-white/[0.02] hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] hover:bg-white/[0.035]',
        className,
      )}
    >
      <div
        className={clsx(
          'flex items-center justify-center rounded-xl border border-[var(--line)] bg-white/[0.04] text-[var(--fg-3)] transition-colors group-hover:text-[var(--accent)]',
          compact ? 'h-8 w-8' : 'h-10 w-10',
        )}
      >
        <Icon size={compact ? 15 : 18} />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-[var(--fg-2)]">{title}</span>
        {hint ? <span className="text-[11px] leading-relaxed text-[var(--fg-3)]">{hint}</span> : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          if (files.length) onFiles(multiple ? files : files.slice(0, 1));
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function ImageLightbox({ open, onOpenChange, src, title, subtitle }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="5xl" hideClose bodyClassName="flex flex-col items-center gap-3 bg-black/40 px-4 py-5">
      {src ? <img src={src} alt={title || ''} className="max-h-[76vh] max-w-full rounded-lg object-contain shadow-2xl" /> : null}
      {title ? (
        <div className="flex items-center gap-2 pb-1">
          <span className="text-[13px] font-medium text-[var(--fg)]">{title}</span>
          {subtitle ? <Badge>{subtitle}</Badge> : null}
        </div>
      ) : null}
    </Modal>
  );
}

// 素材缩略：视频 > 图片 > 音频 > 占位。样式交给调用方控制宽高。
export function AssetMedia({ projectId, asset, className, onPreview, showAudio = true }) {
  const common = clsx('h-full w-full object-cover', className);
  if (asset?.video_path) {
    return <video className={common} src={fileUrl(projectId, asset.video_path)} controls preload="metadata" />;
  }
  if (asset?.image_path) {
    return (
      <img
        className={clsx(common, onPreview && 'cursor-zoom-in')}
        src={fileUrl(projectId, asset.image_path)}
        alt={asset.name || ''}
        loading="lazy"
        onClick={onPreview}
      />
    );
  }
  const audioSrc = asset?.audio_path || asset?.voice_ref;
  if (audioSrc && showAudio) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(120%_120%_at_30%_0%,rgba(255,255,255,.05),transparent_60%)] p-3">
        <FileAudio size={18} className="text-[var(--fg-3)]" />
        <audio src={fileUrl(projectId, audioSrc)} controls className="h-8 w-full" />
      </div>
    );
  }
  const Icon = asset?.category === 'video' ? Film : asset?.category === 'voice' || asset?.category === 'music' || asset?.category === 'sfx' ? FileAudio : ImageIcon;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--fg-4)]">
      <Icon size={18} />
      <span className="text-[10.5px]">{ASSET_CATEGORY_LABEL[asset?.category] || asset?.category || '暂无预览'}</span>
    </div>
  );
}

export function AudioLine({ projectId, path, className }) {
  if (!path) return null;
  return <audio src={fileUrl(projectId, path)} controls preload="metadata" className={clsx('h-9 w-full', className)} />;
}
