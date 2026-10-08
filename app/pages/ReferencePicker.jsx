'use client';
import { useRef } from 'react';
import { CATEGORIES } from './shared';

// ============ 参考图片素材选择器（受控展示组件，不负责上传） ============
// items: [{ key, file, mode: 'reference' | 'library', category }]
// onChange(items): 选择/切换用途/删除后回传最新列表
let seq = 0;
function nextKey() { seq += 1; return 'ref_' + Date.now() + '_' + seq; }

export default function ReferencePicker({ items, onChange }) {
  const fileRef = useRef(null);

  function addFiles(fileList) {
    const next = [];
    for (const file of fileList || []) {
      if (!file.type || !file.type.startsWith('image/')) continue;
      next.push({ key: nextKey(), file, mode: 'reference', category: 'other', previewUrl: URL.createObjectURL(file) });
    }
    if (next.length) onChange([...(items || []), ...next]);
  }

  function patch(key, p) {
    onChange((items || []).map((it) => (it.key === key ? { ...it, ...p } : it)));
  }
  function remove(key) {
    onChange((items || []).filter((it) => it.key !== key));
  }

  return (
    <div className="card" style={{ marginTop: 10, padding: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b style={{ margin: 0 }}>参考图片素材（可选）</b>
        <button onClick={() => fileRef.current && fileRef.current.click()}>＋ 选择参考图片</button>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        「参考生成新素材」会提交给视觉模型分析后据此生成新素材；「导入素材库」直接加入素材库。
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }}
      />
      {items && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {items.map((it) => (
            <div key={it.key} className="row" style={{ gap: 10, alignItems: 'center' }}>
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
              <button onClick={() => remove(it.key)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
