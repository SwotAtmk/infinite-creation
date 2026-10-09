'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api-client.js';
import { CATEGORIES, STATUS_TAG, fileUrl } from './shared';
import { useToast } from '../toast';

// ============ 资产库 ============
export default function AssetsTab({ projectId, running = false }) {
  const toast = useToast();
  const [assets, setAssets] = useState([]);
  const [cat, setCat] = useState('');
  const [form, setForm] = useState({ category: 'character', name: '', description: '' });
  const [edit, setEdit] = useState(null);
  const [voice, setVoice] = useState(null);
  const [uploadTarget, setUploadTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [outfits, setOutfits] = useState({});
  const [ages, setAges] = useState({});
  const fileRef = useRef(null);
  const load = useCallback(() => api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch((e) => toast.error(e.message)), [projectId]);
  useEffect(() => { load(); }, [load]);
  const shownAssets = cat ? assets.filter((a) => a.category === cat) : assets;
  const costumesOfChar = (charId) => assets.filter((a) => a.category === 'costume' && a.parent_id === charId);
  const agesOfChar = (charId) => assets.filter((a) => a.category === 'age' && a.parent_id === charId);
  const editingAsset = edit ? assets.find((x) => x.id === edit.id) : null;

  useEffect(() => {
    if (!edit) return;
    const onKey = (e) => { if (e.key === 'Escape') setEdit(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [edit]);

  useEffect(() => {
    if (!voice) return;
    const onKey = (e) => { if (e.key === 'Escape') setVoice(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voice]);

  const voiceAsset = voice ? assets.find((x) => x.id === voice.id) : null;

  // 打开音色设计弹窗：显示/编辑声音限制（voice_desc，性别+年龄+质感）
  function designVoice(a) {
    setVoice({ id: a.id, name: a.name, voice_desc: a.voice_desc || '' });
    // 异步拉取最新资产数据（LLM 可能在后台已重新生成音色并回写 voice_desc），
    // 弹窗秒开（旧值），随后更新为最新限制与试听
    api.get('/api/projects/' + projectId + '/assets/' + a.id).then((x) => {
      setVoice((v) => (v && v.id === a.id ? { ...v, voice_desc: x.voice_desc || '', voice_ref: x.voice_ref || '', refreshAt: Date.now() } : v));
    }).catch(() => {});
  }
  // 保存：仅把声音限制写入资产，不触发生成
  async function saveVoice() {
    try {
      await api.patch('/api/projects/' + projectId + '/assets/' + voice.id, { voice_desc: voice.voice_desc });
      toast.success('已保存声音限制');
      setVoice(null);
      load();
    } catch (e) { toast.error(e.message); }
  }
  // 重新生成：先同步声音限制，再用新限制提交音色设计（朗读内容沿用现有兜底逻辑）
  async function regenVoice() {
    try {
      await api.patch('/api/projects/' + projectId + '/assets/' + voice.id, { voice_desc: voice.voice_desc });
      await api.post('/api/projects/' + projectId + '/assets/' + voice.id + '/design-voice', { voice_description: voice.voice_desc || undefined });
      toast.success('已提交音色设计，稍后在「运行日志」查看进度');
      setVoice(null);
      load();
    } catch (e) { toast.error(e.message); }
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
    } catch (e) { toast.error('上传失败：' + e.message); }
  }

  async function create() {
    try { await api.post('/api/projects/' + projectId + '/assets', form); setForm({ ...form, name: '', description: '' }); load(); } catch (e) { toast.error(e.message); }
  }
  async function del(a) {
    if (!(await toast.confirm('删除资产「' + a.name + '」？此操作不可逆。', { danger: true }))) return;
    try { await api.del('/api/projects/' + projectId + '/assets/' + a.id); toast.success('已删除「' + a.name + '」'); load(); } catch (e) { toast.error(e.message); }
  }
  async function regenImage(a, mode) {
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/generate', { mode: mode || 't2i' });
      toast.success((mode === 'i2i' ? '已提交重新生成（图生图，基于现有图）' : '已提交生成图片') + '，稍后在「运行日志」查看进度');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function changeOutfit(a) {
    const outfit = await toast.prompt('输入服装描述（如：冬季红色斗篷 / 校园制服 / 战斗铠甲）', { defaultValue: outfits[a.id] || '', placeholder: '服装描述' });
    if (!outfit) return;
    setOutfits({ ...outfits, [a.id]: outfit });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-outfit', { outfit });
      toast.success('已提交换装（图生图），稍后在「运行日志」查看进度');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function changeAge(a) {
    const age = await toast.prompt('输入年龄/时期描述（如：年轻时 / 中年时 / 老年时）', { defaultValue: ages[a.id] || '', placeholder: '年龄/时期描述' });
    if (!age) return;
    setAges({ ...ages, [a.id]: age });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-age', { age });
      toast.success('已提交年龄变化（图生图），稍后在「运行日志」查看进度');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function saveEdit() {
    try { await api.patch('/api/projects/' + projectId + '/assets/' + edit.id, { name: edit.name, description: edit.description, prompt: edit.prompt }); toast.success('已保存'); setEdit(null); load(); } catch (e) { toast.error(e.message); }
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
              <div style={{ marginTop: 6 }}>
                  <b>{a.name}</b>
                  <div className="muted">{a.category}{(a.category === 'costume' || a.category === 'age') && a.parent_id ? ' · 来自「' + (assets.find((x) => x.id === a.parent_id)?.name || a.parent_id) + '」' : ''}</div>
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
                        <button disabled={running} onClick={() => regenImage(a, 't2i')}>生成图</button>
                        {a.image_path && <button disabled={running} onClick={() => regenImage(a, 'i2i')} title="基于现有图重新生成（图生图，保持一致性）">重新生成</button>}
                      </>
                    )}
                    {a.category === 'character' && a.image_path && <button disabled={running} onClick={() => changeOutfit(a)} title="基于角色图用图生图生成一套新服装">换装</button>}
                    {a.category === 'character' && a.image_path && <button disabled={running} onClick={() => changeAge(a)} title="基于角色图用图生图生成同一人物的不同年龄/时期样貌">年龄</button>}
                    {(a.category === 'character' || a.category === 'voice') && <button disabled={running} onClick={() => designVoice(a)}>设计音色</button>}
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
                  {a.category === 'character' && agesOfChar(a.id).length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ marginBottom: 4 }}>年龄/时期（{agesOfChar(a.id).length} 个）</div>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        {agesOfChar(a.id).map((g) => (
                          <div key={g.id} style={{ textAlign: 'center', width: 56 }}>
                            {g.image_path
                              ? <img src={fileUrl(projectId, g.image_path)} onClick={() => setPreview(g)} style={{ width: 52, height: 52, objectFit: 'cover', cursor: 'zoom-in', borderRadius: 4 }} title={g.name + '（点击预览）'} />
                              : <div className="thumb" style={{ width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>年龄</div>}
                            <div className="muted" style={{ fontSize: 10, wordBreak: 'break-all', lineHeight: 1.2 }}>{g.name.replace(a.name + '-', '')}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
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
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860, width: '94vw' }}>
            <h2>编辑素材</h2>
            <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 300px', minWidth: 260 }}>
                {editingAsset && (editingAsset.video_path || editingAsset.image_path || editingAsset.audio_path || editingAsset.voice_ref) ? (
                  editingAsset.video_path
                    ? <video controls src={fileUrl(projectId, editingAsset.video_path)} style={{ width: '100%', borderRadius: 8, maxHeight: 300 }} />
                    : editingAsset.image_path
                      ? <img src={fileUrl(projectId, editingAsset.image_path)} alt={editingAsset.name} style={{ width: '100%', borderRadius: 8, maxHeight: 340, objectFit: 'contain' }} />
                      : <audio controls src={fileUrl(projectId, editingAsset.audio_path || editingAsset.voice_ref)} style={{ width: '100%', marginTop: 6 }} />
                ) : (
                  <div className="thumb" style={{ width: '100%', minHeight: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{editingAsset ? editingAsset.category : ''}</div>
                )}
                {editingAsset && (
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>{editingAsset.category}{(editingAsset.category === 'costume' || editingAsset.category === 'age') && editingAsset.parent_id ? ' · 来自「' + (assets.find((x) => x.id === editingAsset.parent_id)?.name || editingAsset.parent_id) + '」' : ''}</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 320 }}>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>名称</label>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="名称" style={{ width: '100%', boxSizing: 'border-box' }} />
                <label style={{ display: 'block', marginTop: 12, marginBottom: 4, fontWeight: 600 }}>描述</label>
                <textarea value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="描述（可选，Agent 会自动补全）" rows={4} style={{ width: '100%', boxSizing: 'border-box' }} />
                <label style={{ display: 'block', marginTop: 12, marginBottom: 4, fontWeight: 600 }}>提示词</label>
                <textarea value={edit.prompt || ''} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} placeholder="提示词（可选，用于生成/重新生成）" rows={8} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }} />
                <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
                  <button onClick={() => setEdit(null)}>取消</button>
                  <button className="primary" onClick={saveEdit}>保存</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {voice && (
        <div className="modal-bg" onClick={() => setVoice(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860, width: '94vw' }}>
            <h2>设计音色 · {voice.name}</h2>
            <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 300px', minWidth: 260 }}>
                {voiceAsset && (voiceAsset.audio_path || voiceAsset.voice_ref || voice.voice_ref) ? (
                  <div>
                    <div className="muted" style={{ marginBottom: 6 }}>当前音色试听（若有）</div>
                    <audio controls src={fileUrl(projectId, voiceAsset.audio_path || voice.voice_ref || voiceAsset.voice_ref)} style={{ width: '100%', borderRadius: 8 }} />
                  </div>
                ) : (
                  <div className="thumb" style={{ width: '100%', minHeight: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>尚无音色样本</div>
                )}
                <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
                  {!voice.voice_desc?.trim()
                    ? '尚未设置声音限制，生成时将由系统按角色性别/年龄自动推断。建议填写，避免男主生成女声。'
                    : '声音限制会写入资产并作为 TTS 工作流的「声音描述」输入（性别 + 年龄段 + 音色质感）。朗读内容不做编辑，沿用当前文案。'}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 320 }}>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>声音限制（性别 / 年龄 / 质感）</label>
                <textarea
                  value={voice.voice_desc || ''}
                  onChange={(e) => setVoice({ ...voice, voice_desc: e.target.value })}
                  placeholder="如：青年男性，嗓音低沉温和，语速偏慢，带一点书卷气的平静口吻"
                  rows={6}
                  style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }}
                />
                <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
                  <button onClick={() => setVoice(null)}>取消</button>
                  <button disabled={running} onClick={saveVoice}>保存</button>
                  <button className="primary" disabled={running} onClick={regenVoice}>重新生成</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}