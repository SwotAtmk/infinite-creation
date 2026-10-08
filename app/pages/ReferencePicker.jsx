'use client';
import { useRef } from 'react';
import { CATEGORIES, fileUrl } from './shared';

// ============ 参考图片素材列表（统一：已上传素材 + 待上传本地文件） ============
// items: 待上传的本地文件 [{ key, file, mode: 'reference'|'library', category, description, previewUrl }]
// onChange(items): 待上传项变化后回传最新列表
// saved: 已上传的参考素材 [{ id, name, image_path, mode, category, description }]（可编辑）
// onUpdateSaved(id, patch): 编辑某条已上传素材（mode / category / description）
// onDeleteSaved(id): 删除某条已上传素材
let seq = 0;
function nextKey() { seq += 1; return 'ref_' + Date.now() + '_' + seq; }

export default function ReferencePicker({ projectId, items, onChange, saved = [], onUpdateSaved, onDeleteSaved, allowAdd = true }) {
  const fileRef = useRef(null);

  function addFiles(fileList) {
    const next = [];
    for (const file of fileList || []) {
      if (!file.type || !file.type.startsWith('image/')) continue;
      next.push({ key: nextKey(), file, mode: 'reference', category: 'other', description: '', previewUrl: URL.createObjectURL(file) });
    }
    if (next.length) onChange([...(items || []), ...next]);
  }

  function patch(key, p) {
    onChange((items || []).map((it) => (it.key === key ? { ...it, ...p } : it)));
  }
  function remove(key) {
    onChange((items || []).filter((it) => it.key !== key));
  }

  const savedList = saved || [];
  const pendingList = items || [];
  const hasAny = savedList.length > 0 || pendingList.length > 0;

  return (
    <div className="card" style={{ marginTop: 10, padding: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b style={{ margin: 0 }}>参考图片素材（可选）</b>
        {allowAdd && <button onClick={() => fileRef.current && fileRef.current.click()}>＋ 选择参考图片</button>}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        「参考生成新素材」会提交给视觉模型分析后据此生成新素材；「导入素材库」直接加入素材库。用途描述可随时编辑。
      </p>
      {allowAdd && (
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }}
        />
      )}
      {hasAny && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {savedList.map((r) => (
            <div key={'saved_' + r.id} style={{ border: '1px solid #232936', borderRadius: 6, padding: 8 }}>
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                {r.image_path
                  ? <img src={fileUrl(projectId, r.image_path)} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4 }} title={r.name} />
                  : <div className="thumb" style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4 }}>图</div>}
                <span style={{ flex: 1, wordBreak: 'break-all' }}>{r.name || '未命名'}</span>
                <select value={r.mode} onChange={(e) => onUpdateSaved && onUpdateSaved(r.id, { mode: e.target.value })}>
                  <option value="reference">参考生成新素材</option>
                  <option value="library">导入素材库</option>
                </select>
                {r.mode === 'library' && (
                  <select value={r.category} onChange={(e) => onUpdateSaved && onUpdateSaved(r.id, { category: e.target.value })}>
                    {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
                {onDeleteSaved && <button onClick={() => onDeleteSaved(r.id)}>删除</button>}
              </div>
              <input
                defaultValue={r.description || ''}
                onBlur={(e) => { const v = e.target.value || ''; if (v !== (r.description || '')) onUpdateSaved && onUpdateSaved(r.id, { description: v }); }}
                placeholder="用途 / 用于剧情哪部分（可选，提交给 Agent 参考）"
                style={{ width: '100%', marginTop: 6 }}
              />
            </div>
          ))}
          {pendingList.map((it) => (
            <div key={it.key} style={{ border: '1px solid #232936', borderRadius: 6, padding: 8 }}>
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                <img src={it.previewUrl} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4 }} />
                <span style={{ flex: 1, wordBreak: 'break-all' }}>{it.file.name}</span>
                <select value={it.mode} onChange={(e) => patch(it.key, { mode: e.target.value })}>
                  <option value="reference">参考生成新素材</option>
                  <option value="library">导入素材库</option>
                </select>
                {it.mode === 'library' && (
                  <select value={it.category} onChange={(e) => patch(it.key, { category: e.target.value })}>
                    {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
                <button onClick={() => remove(it.key)}>移除</button>
              </div>
              <input
                value={it.description || ''}
                onChange={(e) => patch(it.key, { description: e.target.value })}
                placeholder="用途 / 用于剧情哪部分（可选，提交给 Agent 参考）"
                style={{ width: '100%', marginTop: 6 }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
