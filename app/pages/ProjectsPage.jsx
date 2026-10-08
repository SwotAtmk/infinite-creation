'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import { STATUS_TAG, STYLE_OPTIONS, STYLE_CUSTOM, resolveStyle } from './shared';
import ReferencePicker from './ReferencePicker';

// ============ 项目列表 ============
export default function ProjectsPage({ onOpen }) {
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({ name: '', novel: '', idea: '', style: '' });
  const [customStyle, setCustomStyle] = useState('');
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const load = useCallback(() => api.get('/api/projects').then(setProjects).catch(alert), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {}); }, []);

  async function uploadReferences(projectId) {
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', '');
      const res = await fetch('/api/projects/' + projectId + '/references', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('参考图上传失败 HTTP ' + res.status));
      }
    }
  }

  async function create() {
    try {
      const style = resolveStyle(form.style, customStyle);
      const p = await api.post('/api/projects', { ...form, style });
      await uploadReferences(p.id);
      onOpen(p.id);
    } catch (e) { alert(e.message); }
  }
  async function del(id) {
    if (!confirm('删除该项目及其所有素材？')) return;
    await api.del('/api/projects/' + id); load();
  }

  return (
    <div>
      <div className="card">
        <h2>新建项目</h2>
        <div className="row">
          <input placeholder="项目名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.style} onChange={(e) => setForm({ ...form, style: e.target.value })} style={{ width: 240 }}>
            <option value="">选择画面风格（可选）</option>
            {STYLE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {form.style === STYLE_CUSTOM && (
            <input placeholder="请填写自定义风格" value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} style={{ width: 240 }} />
          )}
        </div>
        <br />
        <textarea placeholder="粘贴小说原文（可留空，用下方一句话想法）" value={form.novel} onChange={(e) => setForm({ ...form, novel: e.target.value })} />
        <br />
        <input placeholder="或：一句话故事想法" value={form.idea} onChange={(e) => setForm({ ...form, idea: e.target.value })} style={{ width: '100%' }} />
        {vision && <ReferencePicker items={refs} onChange={setRefs} />}
        <br />
        <button className="primary" disabled={!form.name} onClick={create}>创建并打开</button>
      </div>

      <div className="card">
        <h2>项目列表</h2>
        {projects.map((p) => (
          <div key={p.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #232936' }}>
            <div>
              <a onClick={() => onOpen(p.id)} style={{ cursor: 'pointer', fontSize: 15 }}>{p.name}</a>
              <span className="muted"> · 资产 {p.assetCount} · 分镜 {p.shotCount} · </span>
              <span className={'tag ' + (STATUS_TAG[p.status] || '')}>{p.status || 'idle'}</span>
            </div>
            <button className="danger" onClick={() => del(p.id)}>删除</button>
          </div>
        ))}
        {!projects.length && <p className="muted">暂无项目</p>}
      </div>
    </div>
  );
}
