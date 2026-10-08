'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import ReferencePicker from './ReferencePicker';
import { useToast } from '../toast';

// ============ 页1 · 章节管理 ============
export default function ChaptersView({ projectId, chapters, cursor, setCursor, onRefresh }) {
  const toast = useToast();
  const cur = chapters[cursor] || chapters[0] || null;
  const [title, setTitle] = useState('');
  const [novel, setNovel] = useState('');
  const [dirty, setDirty] = useState(false);
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const [savedRefs, setSavedRefs] = useState([]);

  useEffect(() => { if (cur) { setTitle(cur.title); setNovel(cur.novel || ''); setDirty(false); } }, [cur && cur.id]);
  useEffect(() => { api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {}); }, []);
  const loadRefs = useCallback(() => {
    api.get('/api/projects/' + projectId + '/references').then(setSavedRefs).catch(alert);
  }, [projectId]);
  useEffect(() => { loadRefs(); }, [loadRefs]);

  // 参考素材按章节归属：仅展示当前章（chapter_id = cur.id）的参考素材
  const chapterRefs = cur ? savedRefs.filter((r) => r.chapter_id === cur.id) : [];

  async function save() {
    try { await api.patch('/api/projects/' + projectId + '/chapters/' + cur.id, { title, novel }); toast.success('已保存「' + title + '」'); setDirty(false); onRefresh(); } catch (e) { toast.error(e.message); }
  }
  async function addChapter() {
    try { const c = await api.post('/api/projects/' + projectId + '/chapters', { title: '第' + (chapters.length + 1) + '章' }); toast.success('已新增章节'); onRefresh(); setCursor(Math.max(0, chapters.length)); } catch (e) { toast.error(e.message); }
  }
  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」及其分镜？此操作不可逆。', { danger: true }))) return;
    try { await api.del('/api/projects/' + projectId + '/chapters/' + c.id); toast.success('已删除「' + c.title + '」'); onRefresh(); } catch (e) { toast.error(e.message); }
  }
  async function move(i, dir) {
    const target = i + dir; if (target < 0 || target >= chapters.length) return;
    const a = chapters[i], b = chapters[target];
    try { await api.patch('/api/projects/' + projectId + '/chapters/' + a.id, { seq: b.seq }); await api.patch('/api/projects/' + projectId + '/chapters/' + b.id, { seq: a.seq }); onRefresh(); } catch (e) { toast.error(e.message); }
  }

  async function uploadRefs() {
    if (!cur) return;
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', cur.id);
      fd.append('description', it.description || '');
      const res = await fetch('/api/projects/' + projectId + '/references', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('参考图上传失败 HTTP ' + res.status));
      }
    }
    setRefs([]);
    loadRefs();
  }
  async function delRef(rid) {
    try { await api.del('/api/projects/' + projectId + '/references/' + rid); loadRefs(); } catch (e) { alert(e.message); }
  }
  async function updateRef(rid, patch) {
    // 乐观更新，失败回滚重载
    setSavedRefs((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
    try {
      await api.patch('/api/projects/' + projectId + '/references/' + rid, patch);
    } catch (e) { alert(e.message); loadRefs(); }
  }

  const label = { empty: '无分镜', pending: '待生成', running: '生成中', done: '完成', failed: '失败' };
  const tag = { done: 'tag done', running: 'tag running', failed: 'tag failed', pending: '', empty: '' };
  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>章节管理</h2>
          <button className="primary" onClick={addChapter}>＋ 新增章节</button>
        </div>
        <p className="muted">先规划整本书的章节骨架，然后在「生成内容」页逐章生成。素材库为全项目共用。</p>
        {chapters.map((c, i) => (
          <div key={c.id} className="card" style={{ marginBottom: 10, borderColor: i === cursor ? '#2f6feb' : undefined }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row">
                <b>{c.title}</b>
                <span className={'tag ' + (tag[c.genStatus] || '')}>{label[c.genStatus] || c.status}{c.shotCount > 0 ? ' · ' + c.doneCount + '/' + c.shotCount : ''}</span>
              </div>
              <div className="row">
                <button onClick={() => setCursor(i)} className={i === cursor ? 'primary' : ''}>编辑</button>
                <button onClick={() => move(i, -1)}>↑</button>
                <button onClick={() => move(i, 1)}>↓</button>
                <button onClick={() => removeChapter(c)}>删除</button>
              </div>
            </div>
            {i === cursor && (
              <div style={{ marginTop: 10 }}>
                <div className="row">
                  <input value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} style={{ width: 160 }} placeholder="章节标题" />
                  <button className="primary" onClick={save} disabled={!dirty}>保存本章</button>
                </div>
                <h3 style={{ margin: '8px 0 4px' }}>本章小说原文</h3>
                <textarea value={novel} onChange={(e) => { setNovel(e.target.value); setDirty(true); }} style={{ minHeight: 130 }} placeholder="粘贴或编辑本章原文…" />
                <ReferencePicker
                  projectId={projectId}
                  items={refs}
                  onChange={setRefs}
                  saved={chapterRefs}
                  onUpdateSaved={updateRef}
                  onDeleteSaved={delRef}
                  allowAdd={vision}
                />
                {vision && refs.length > 0 && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="primary" onClick={uploadRefs}>上传本章参考素材</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {!chapters.length && <p className="muted">还没有章节，点「＋ 新增章节」。</p>}
      </div>
    </div>
  );
}
