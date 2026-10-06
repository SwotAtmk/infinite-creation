'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

// ============ 技能 ============
export default function SkillsTab() {
  const toast = useToast();
  const [skills, setSkills] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const load = useCallback(() => api.get('/api/skills').then(setSkills).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function rescan() { await api.post('/api/skills/rescan'); load(); }
  function pickZip() { if (fileRef.current) fileRef.current.click(); }
  async function doUploadZip(file) {
    if (!file) return;
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      toast.success('已安装技能：' + (j.installed || []).map((s) => s.name).join('、'));
      load();
    } catch (e) { toast.error('上传失败：' + e.message); }
    finally { setUploading(false); }
  }
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>已安装技能（{skills.length}）</h2>
        <div className="row">
          <button onClick={pickZip} disabled={uploading}>{uploading ? '上传中…' : '上传技能包 (zip)'}</button>
          <button onClick={rescan}>重新扫描 skills/</button>
        </div>
      </div>
      {skills.map((s) => (
        <div key={s.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #232936' }}>
          <div>
            <b>{s.name}</b> <span className="tag">{s.source}</span>
            <div className="muted">{s.description}</div>
          </div>
        </div>
      ))}
      <input ref={fileRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) doUploadZip(f); e.target.value = ''; }} />
      <p className="muted" style={{ marginTop: 12 }}>把 SKILL.md 目录丢进 skills/ 再「重新扫描」即可扩展；或点「上传技能包」上传 zip 压缩包批量安装技能。</p>
    </div>
  );
}