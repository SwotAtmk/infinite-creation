import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Upload } from 'lucide-react';
import { api, uploadBinary } from '../lib/api.js';
import { fileUrl } from '../lib/format.js';
import { Button, Field, Select } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { FileDrop } from './media.jsx';
import { useToast } from './toast.jsx';

const LABEL = { character: '角色', scene: '场景', prop: '道具', costume: '服装', age: '年龄', audio: '音频' };
const AUDIO_CATEGORIES = ['voice', 'music', 'sfx'];

export default function MaterialPicker({ projectId, assets, category, mode, replaceAssetId, assignedIds = [], charIds = [], onPick, onCancel }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const isAudio = category === 'audio';
  const isVariant = category === 'costume' || category === 'age';
  const characters = (assets || []).filter((a) => a.category === 'character');
  const shotChars = (charIds || []).map((id) => characters.find((c) => c.id === id)).filter(Boolean);
  const shotCharIds = new Set(shotChars.map((c) => c.id));
  const parentChoices = shotChars;
  const [parentId, setParentId] = useState(() => (isVariant && parentChoices.length === 1 ? parentChoices[0].id : ''));

  const list = (assets || []).filter((a) => {
    if (isAudio) return AUDIO_CATEGORIES.includes(a.category);
    if (a.category !== category) return false;
    if (isVariant) return shotCharIds.has(a.parent_id);
    return true;
  });
  const disabledIds = (assignedIds || []).filter((id) => id !== replaceAssetId);

  async function upload(file) {
    const name = await toast.prompt('新素材名称', {
      defaultValue: (file.name || '').replace(/\.[^.]+$/, ''),
      placeholder: '素材名称',
    });
    if (!name) return;
    if (isVariant && !parentId) {
      toast.error('请先选择该服装 / 年龄变体所属的角色');
      return;
    }
    setBusy(true);
    try {
      const assetCategory = isAudio ? 'voice' : category;
      const a = await api.post('/api/projects/' + projectId + '/assets', isVariant ? { category: assetCategory, name, parent_id: parentId } : { category: assetCategory, name });
      await uploadBinary('/api/projects/' + projectId + '/assets/' + a.id + '/upload', file, 'application/octet-stream');
      onPick(a.id);
    } catch (e) {
      toast.error('上传失败：' + e.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onCancel()}
      title={(LABEL[category] || category) + ' · ' + (mode === 'replace' ? '替换' : '添加')}
      description={'从素材库选择已有「' + (LABEL[category] || category) + '」，或上传新' + (isAudio ? '音频' : '图') + '。'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="md" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" size="md" disabled={busy || (isVariant && !parentChoices.length)} onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> 上传新素材
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {isVariant ? (
          <>
            <Field label="所属角色" hint="只显示本镜角色，其它角色的服装 / 年龄变体挂在本镜不会生效。">
              <Select
                value={parentId}
                onChange={setParentId}
                items={parentChoices.map((c) => ({ value: c.id, label: c.name }))}
                placeholder={parentChoices.length ? '选择角色' : '本镜还没有绑定角色'}
              />
            </Field>
            {!parentChoices.length ? (
              <p className="m-0 text-[11.5px] leading-relaxed text-[var(--accent)]">
                该分镜还没有绑定角色：请先在分镜里添加角色，再来添加该角色的服装 / 年龄。
              </p>
            ) : null}
          </>
        ) : null}

        <input
          ref={fileRef}
          type="file"
          accept={isAudio ? 'audio/*' : 'image/*'}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';
            if (f) upload(f);
          }}
        />

        {list.length ? (
          <div className="grid max-h-[380px] grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3 overflow-y-auto pr-1">
            {list.map((a) => {
              const disabled = disabledIds.includes(a.id);
              const pick = () => !disabled && !busy && onPick(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={disabled || busy}
                  onClick={pick}
                  title={disabled ? '已在该分镜中使用' : '点击选择'}
                  className={clsx(
                    'group flex flex-col gap-1.5 rounded-xl border p-1.5 text-left transition-all duration-150',
                    disabled
                      ? 'cursor-not-allowed border-[var(--line)] opacity-40'
                      : 'border-[var(--line)] bg-white/[0.02] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] hover:bg-white/[0.04]',
                  )}
                >
                  {isAudio ? (
                    a.audio_path || a.voice_ref ? (
                      <audio src={fileUrl(projectId, a.audio_path || a.voice_ref)} controls className="h-8 w-full" onClick={(e) => e.stopPropagation()} />
                    ) : (
                      <div className="flex h-16 w-full items-center justify-center rounded-lg bg-white/[0.03] text-[10px] text-[var(--fg-4)]">音频</div>
                    )
                  ) : a.image_path ? (
                    <img src={fileUrl(projectId, a.image_path)} alt={a.name} loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-white/[0.03] text-[10px] text-[var(--fg-4)]">{LABEL[category]}</div>
                  )}
                  <span className="truncate px-0.5 text-[11px] text-[var(--fg-2)]">{a.name}{disabled ? '（已使用）' : ''}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <FileDrop
            compact
            accept={isAudio ? 'audio/*' : 'image/*'}
            onFiles={(files) => files[0] && upload(files[0])}
            title={'素材库暂无「' + (LABEL[category] || category) + '」'}
            hint={'点击或拖拽上传新' + (isAudio ? '音频' : '图')}
          />
        )}
      </div>
    </Modal>
  );
}
