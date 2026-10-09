'use client';
import { useRef, useState } from 'react';
import { api } from '../api-client.js';
import { fileUrl } from './shared';
import { useToast } from '../toast';

const LABEL = { character: '角色', scene: '场景', prop: '道具', costume: '服装', age: '年龄' };

export default function ShotMaterialPicker({ projectId, assets, category, mode, replaceAssetId, assignedIds = [], onPick, onCancel }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const list = (assets || []).filter((a) => a.category === category);
  const disabledIds = (assignedIds || []).filter((id) => id !== replaceAssetId);

  async function upload(file) {
    const name = await toast.prompt('新素材名称', { defaultValue: (file.name || '').replace(/\.[^.]+$/, ''), placeholder: '素材名称' });
    if (!name) return;
    setBusy(true);
    try {
      const a = await api.post('/api/projects/' + projectId + '/assets', { category, name });
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/projects/' + projectId + '/assets/' + a.id + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + res.status)); }
      onPick(a.id);
    } catch (e) { toast.error('上传失败：' + e.message); setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, textAlign: 'left' }}>
        <h3 style={{ marginTop: 0 }}>{(LABEL[category] || category) + ' · ' + (mode === 'replace' ? '替换' : '添加')}</h3>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="muted">从素材库选择已有「{LABEL[category] || category}」，或上传新图</span>
          <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>＋ 上传新素材</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) upload(f); }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10, maxHeight: 320, overflow: 'auto' }}>
          {list.map((a) => {
            const disabled = disabledIds.includes(a.id);
            return (
              <div key={a.id} style={{ textAlign: 'center', opacity: disabled ? 0.4 : 1 }}>
                {a.image_path
                  ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={() => !disabled && !busy && onPick(a.id)} style={{ cursor: disabled ? 'not-allowed' : 'pointer' }} title={disabled ? '已在该分镜中使用' : '点击选择'} />
                  : <div className="thumb" onClick={() => !disabled && !busy && onPick(a.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'not-allowed' : 'pointer' }}>{LABEL[category]}</div>}
                <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.name}{disabled ? '（已使用）' : ''}</div>
              </div>
            );
          })}
          {!list.length && <p className="muted" style={{ gridColumn: '1 / -1' }}>素材库暂无「{LABEL[category] || category}」素材，可上传新图。</p>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onCancel} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );
}
