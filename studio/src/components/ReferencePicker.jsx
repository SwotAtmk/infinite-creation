import { useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { fileUrl } from '../lib/format.js';
import { ASSET_CATEGORIES, ASSET_CATEGORY_LABEL, isReferenceImageName, isVariantAssetCategory, REFERENCE_IMAGE_EXTS, REFERENCE_IMAGE_MAX_BYTES } from '../lib/shared.js';
import { Button, Input, Select } from './ui.jsx';
import { FileDrop, ImageLightbox } from './media.jsx';
import { useToast } from './toast.jsx';

let seq = 0;
function nextKey() {
  seq += 1;
  return 'ref_' + Date.now() + '_' + seq;
}

const LIB_CATEGORIES = ASSET_CATEGORIES.filter((c) => !isVariantAssetCategory(c.id)).map((c) => ({ value: c.id, label: c.label }));
function libCategoryOptions(cur) {
  if (isVariantAssetCategory(cur)) {
    return [{ value: cur, label: ASSET_CATEGORY_LABEL[cur] || cur }, ...LIB_CATEGORIES];
  }
  return LIB_CATEGORIES;
}

const MODE_ITEMS = [
  { value: 'reference', label: '参考生成新素材' },
  { value: 'library', label: '导入素材库' },
];

export default function ReferencePicker({ projectId, items = [], onChange, saved = [], onUpdateSaved, onDeleteSaved, allowAdd = true }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);

  function addFiles(fileList) {
    const next = [];
    const badExt = [];
    const tooBig = [];
    for (const file of fileList || []) {
      if (!isReferenceImageName(file.name)) {
        badExt.push(file.name);
        continue;
      }
      if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
        tooBig.push(file.name);
        continue;
      }
      next.push({ key: nextKey(), file, mode: 'reference', category: 'other', description: '', previewUrl: URL.createObjectURL(file) });
    }
    if (badExt.length) toast.error('已跳过非支持格式：' + badExt.join('、') + '（仅支持 ' + REFERENCE_IMAGE_EXTS.map((e) => e.slice(1)).join('/') + '）');
    if (tooBig.length) toast.error('已跳过超过 10MB 的文件：' + tooBig.join('、'));
    if (next.length) onChange([...items, ...next]);
  }

  function patch(key, p) {
    onChange(items.map((it) => (it.key === key ? { ...it, ...p } : it)));
  }

  const hasAny = saved.length > 0 || items.length > 0;

  return (
    <div className="flex flex-col gap-2.5">
      {allowAdd ? (
        <FileDrop
          accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
          multiple
          onFiles={addFiles}
          icon={ImagePlus}
          title="拖拽或点击添加参考图片"
          hint="PNG / JPG / WEBP / GIF，单张 ≤ 10MB；可多选"
          compact
        />
      ) : null}

      {hasAny ? (
        <div className="flex flex-col gap-2">
          {saved.map((r) => (
            <div key={'saved_' + r.id} className="panel-flat flex flex-col gap-2 p-2.5">
              <div className="flex items-center gap-3">
                {r.image_path ? (
                  <img
                    src={fileUrl(projectId, r.image_path)}
                    alt=""
                    onClick={() => setPreview({ url: fileUrl(projectId, r.image_path), title: r.name })}
                    className="h-11 w-11 shrink-0 cursor-zoom-in rounded-lg object-cover ring-1 ring-[var(--line)]"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-[10px] text-[var(--fg-4)]">图片</div>
                )}
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--fg-2)]">{r.name || '未命名'}</span>
                <div className="w-[140px] shrink-0">
                  <Select
                    value={r.mode}
                    onChange={(v) => onUpdateSaved?.(r.id, { mode: v })}
                    items={MODE_ITEMS}
                    size="sm"
                  />
                </div>
                {r.mode === 'library' ? (
                  <div className="w-[96px] shrink-0">
                    <Select
                      value={r.category}
                      onChange={(v) => onUpdateSaved?.(r.id, { category: v })}
                      items={libCategoryOptions(r.category)}
                      size="sm"
                    />
                  </div>
                ) : null}
                {onDeleteSaved ? (
                  <Button variant="ghost" size="iconSm" aria-label="删除参考图" onClick={() => onDeleteSaved(r.id)}>
                    <X size={13} />
                  </Button>
                ) : null}
              </div>
              <Input
                defaultValue={r.description || ''}
                onBlur={(e) => {
                  const v = e.target.value || '';
                  if (v !== (r.description || '')) onUpdateSaved?.(r.id, { description: v });
                }}
                placeholder="用途 / 用于剧情哪部分（可选，提交给 Agent 参考）"
                className="h-9 text-[12.5px]"
              />
            </div>
          ))}

          {items.map((it) => (
            <div key={it.key} className="panel-flat flex flex-col gap-2 p-2.5">
              <div className="flex items-center gap-3">
                <img
                  src={it.previewUrl}
                  alt=""
                  onClick={() => setPreview({ url: it.previewUrl, title: it.file.name })}
                  className="h-11 w-11 shrink-0 cursor-zoom-in rounded-lg object-cover ring-1 ring-[var(--line)]"
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--fg-2)]">{it.file.name}</span>
                <div className="w-[140px] shrink-0">
                  <Select value={it.mode} onChange={(v) => patch(it.key, { mode: v })} items={MODE_ITEMS} size="sm" />
                </div>
                {it.mode === 'library' ? (
                  <div className="w-[96px] shrink-0">
                    <Select value={it.category} onChange={(v) => patch(it.key, { category: v })} items={libCategoryOptions(it.category)} size="sm" />
                  </div>
                ) : null}
                <Button variant="ghost" size="iconSm" aria-label="移除" onClick={() => onChange(items.filter((x) => x.key !== it.key))}>
                  <X size={13} />
                </Button>
              </div>
              <Input
                value={it.description || ''}
                onChange={(e) => patch(it.key, { description: e.target.value })}
                placeholder="用途 / 用于剧情哪部分（可选，提交给 Agent 参考）"
                className="h-9 text-[12.5px]"
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
          「参考生成新素材」会提交给视觉模型分析后据此生成新素材；「导入素材库」直接加入素材库。
        </p>
      )}

      <ImageLightbox open={!!preview} onOpenChange={(o) => !o && setPreview(null)} src={preview?.url} title={preview?.title} />
    </div>
  );
}
