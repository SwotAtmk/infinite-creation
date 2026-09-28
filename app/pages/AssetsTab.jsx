'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api-client.js';
import { CATEGORIES, STATUS_TAG, fileUrl } from './shared';

// ============ 资产库 ============
export default function AssetsTab({ projectId }) {
  const [assets, setAssets] = useState([]);
  const [cat, setCat] = useState('');
  const [form, setForm] = useState({ category: 'character', name: '', description: '' });
  const [edit, setEdit] = useState(null);
  const [uploadTarget, setUploadTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [outfits, setOutfits] = useState({});
  const fileRef = useRef(null);
  const load = useCallback(() => api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch(alert), [projectId]);
  useEffect(() => { load(); }, [load]);
  const shownAssets = cat ? assets.filter((a) => a.category === cat) : assets;
  const costumesOfChar = (charId) => assets.filter((a) => a.category === 'costume' && a.parent_id === charId);

  async function designVoice(a) {
    try { await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/design-voice'); alert('已提交音色设计，稍后在「运行日志」查看进度'); load(); } catch (e) { alert(e.message); }
  }
  function pickUpload(a) { setUploadTarget(a.id); if (fileRef.current) fileRef.current.click(); }
  async function doUpload(aid, file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/projects/' + projectId + '/assets/' + aid + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => { return {}; });
        throw new Error(j.error || ('HTTP ' + res.status));
      }
      load();
    } catch (e) { alert('上传失败：' + e.message); }
  }

  async function create() {
    try { await api.post('/api/projects/' + projectId + '/assets', form); setForm({ ...form, name: '', description: '' }); load(); } catch (e) { alert(e.message); }
  }
  async function del(a) {
    if (!window.confirm('删除资产「' + a.name + '」？此操作不可逆。')) return;
    try { await api.del('/api/projects/' + projectId + '/assets/' + a.id); load(); } catch (e) { alert(e.message); }
  }
  async function regenImage(a, mode) {
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/generate', { mode: mode || 't2i' });
      alert((mode === 'i2i' ? '已提交重新生成（图生图，基于现有图）' : '已提交生成图片') + '，稍后在「运行日志」查看进度');
      load();
    } catch (e) { alert(e.message); }
  }
  async function changeOutfit(a) {
    const outfit = window.prompt('输入服装描述（如：冬季红色斗篷 / 校园制服 / 战斗铠甲）', outfits[a.id] || '');
    if (!outfit || !outfit.trim()) return;
    setOutfits({ ...outfits, [a.id]: outfit.trim() });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-outfit', { outfit: outfit.trim() });
      alert('已提交换装（图生图），稍后在「生成内容」的运行日志查看进度');
      load();
    } catch (e) { alert(e.message); }
  }
  async function saveEdit() {
    try { await api.patch('/api/projects/' + projectId + '/assets/' + edit.id, { name: edit.name, description: edit.description, prompt: edit.prompt }); setEdit(null); load(); } catch (e) { alert(e.message); }
  }

  return (
    <div>
      <div className="card">
        <h2>新建资产</h2>
        <div className="row">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="描述（可选，Agent 会自动补全）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ width: 300 }} />
          <button className="primary" disabled={!form.name} onClick={create}>添加</button>
        </div>
        <p className="muted">素材库为全项目共用、跨章节复用；角色/场景/道具图可由 Agent 生成，也可点「生成图」单独补图。</p>
      </div>
      <div className="card">
        <div className="tabs">
          <button className={cat === '' ? 'active' : ''} onClick={() => setCat('')}>全部</button>
          {CATEGORIES.map(([k, l]) => <button key={k} className={cat === k ? 'active' : ''} onClick={() => setCat(k)}>{l}</button>)}
        </div>
        <div className="grid">
          {shownAssets.map((a) => (
            <div key={a.id}>
              {a.video_path
                ? <video className="thumb" controls src={fileUrl(projectId, a.video_path)} />
                : a.image_path
                  ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={() => setPreview(a)} style={{ cursor: 'zoom-in' }} title="点击预览大图" />
                  : (a.audio_path || a.voice_ref)
                    ? <div className="thumb" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <div className="muted">{a.category}</div>
                        <audio controls src={fileUrl(projectId, a.audio_path || a.voice_ref)} style={{ width: '92%' }} />
                      </div>
                    : <div className="thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{a.category}</div>}
              {edit && edit.id === a.id ? (
                <div style={{ marginTop: 6 }}>
                  <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="名称" style={{ width: '100%' }} />
                  <input value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="描述" style={{ width: '100%', marginTop: 4 }} />
                  <textarea value={edit.prompt || ''} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} placeholder="提示词（可选，用于生成/重新生成）" style={{ width: '100%', marginTop: 4, minHeight: 48 }} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="primary" onClick={saveEdit}>保存</button>
                    <button onClick={() => setEdit(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <b>{a.name}</b>
                  <div className="muted">{a.category}{a.category === 'costume' && a.parent_id ? ' · 来自「' + (assets.find((x) => x.id === a.parent_id)?.name || a.parent_id) + '」' : ''}</div>
                  <div className={'tag ' + (STATUS_TAG[a.status] || '')}>{a.status}</div>
                  {(a.voice_ref || a.audio_path) && (a.image_path || a.video_path) && (
                    <>
                      <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>音色试听</div>
                      <audio controls src={fileUrl(projectId, a.voice_ref || a.audio_path)} style={{ width: '100%', height: 32 }} title="人物参考音色试听" />
                    </>
                  )}
                  <div className="row" style={{ marginTop: 6 }}>
                    {['character', 'scene', 'prop', 'other'].includes(a.category) && (
                      <>
                        <button onClick={() => regenImage(a, 't2i')}>生成图</button>
                        {a.image_path && <button onClick={() => regenImage(a, 'i2i')} title="基于现有图重新生成（图生图，保持一致性）">重新生成</button>}
                      </>
                    )}
                    {a.category === 'character' && a.image_path && <button onClick={() => changeOutfit(a)} title="基于角色图用图生图生成一套新服装">换装</button>}
                    {(a.category === 'character' || a.category === 'voice') && <button onClick={() => designVoice(a)}>设计音色</button>}
                    <button onClick={() => pickUpload(a)}>上传/替换</button>
                    <button onClick={() => setEdit({ id: a.id, name: a.name, description: a.description || '', prompt: a.prompt || '' })}>编辑</button>
                    <button onClick={() => del(a)}>删除</button>
                  </div>
                  {a.category === 'character' && costumesOfChar(a.id).length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ marginBottom: 4 }}>服装（{costumesOfChar(a.id).length} 套）</div>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        {costumesOfChar(a.id).map((c) => (
                          <div key={c.id} style={{ textAlign: 'center', width: 56 }}>
                            {c.image_path
                              ? <img src={fileUrl(projectId, c.image_path)} onClick={() => setPreview(c)} style={{ width: 52, height: 52, objectFit: 'cover', cursor: 'zoom-in', borderRadius: 4 }} title={c.name + '（点击预览）'} />
                              : <div className="thumb" style={{ width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>服装</div>}
                            <div className="muted" style={{ fontSize: 10, wordBreak: 'break-all', lineHeight: 1.2 }}>{c.name.replace(a.name + '-', '')}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        {!assets.length && <p className="muted">暂无资产</p>}
      </div>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f && uploadTarget) doUpload(uploadTarget, f); e.target.value = ''; setUploadTarget(null); }} />
      {preview && (
        <div className="modal-bg" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '90vw', textAlign: 'center' }}>
            <img src={fileUrl(projectId, preview.image_path)} style={{ maxWidth: '100%', maxHeight: '78vh', borderRadius: 6 }} />
            <div style={{ marginTop: 8 }}><b>{preview.name}</b> <span className="muted">{preview.category}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}