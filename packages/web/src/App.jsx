import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';

const CATEGORIES = [
  ['character', '人物'], ['scene', '场景'], ['prop', '道具'], ['costume', '服装'],
  ['voice', '语音'], ['music', '音乐'], ['sfx', '音效'], ['video', '视频'], ['other', '其他'],
];
const VIDEO_RESOLUTIONS = [['360P', '360P'], ['480P', '480P'], ['720P', '720P'], ['1080P', '1080P'], ['custom', '自定义宽高']];
const VIDEO_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
const STATUS_TAG = { done: 'done', failed: 'failed', running: 'running', generating: 'running', pending: '' };

function fileUrl(projectId, rel) {
  if (!rel) return null;
  return '/files/projects/' + projectId + '/' + rel;
}

// 解析对白里的说话人名单（与后端 dialogueSpeakerNames 逻辑保持一致）
function dialogueSpeakers(dialogue) {
  if (!dialogue) return [];
  const names = new Set();
  for (const line of String(dialogue).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(.+?)[：:]/);
    if (!m) continue;
    const name = m[1].replace(/[(（][^()（）]*[)）]/g, '').replace(/[，。、,;；!！?？.·]+$/g, '').trim();
    if (name) names.add(name);
  }
  return [...names];
}

// 回到顶部：右下角悬浮按钮，滚动超过 400px 时显示
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener('scroll', onScroll);
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <button className="back-top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} title="回到顶部">↑</button>
  );
}

export default function App() {
  const [view, setView] = useState({ type: 'list' });
  return (
    <div className="container">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>无限创作 <span className="muted">小说 → 视频 · 全自动 Agent</span></h1>
        <button onClick={() => setView({ type: 'settings' })}>⚙ 设置</button>
      </div>
      {view.type === 'list' && <ProjectsPage onOpen={(id) => setView({ type: 'project', id })} />}
      {view.type === 'project' && <ProjectView id={view.id} onBack={() => setView({ type: 'list' })} />}
      {view.type === 'settings' && <SettingsPage onBack={() => setView({ type: 'list' })} />}
      <BackToTop />
    </div>
  );
}

// ============ 项目列表 ============
function ProjectsPage({ onOpen }) {
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({ name: '', novel: '', idea: '', style: '' });
  const load = useCallback(() => api.get('/api/projects').then(setProjects).catch(alert), []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    try {
      const p = await api.post('/api/projects', form);
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
          <input placeholder="画面风格（如：国漫/3D动画/写实）" value={form.style} onChange={(e) => setForm({ ...form, style: e.target.value })} style={{ width: 240 }} />
        </div>
        <br />
        <textarea placeholder="粘贴小说原文（可留空，用下方一句话想法）" value={form.novel} onChange={(e) => setForm({ ...form, novel: e.target.value })} />
        <br />
        <input placeholder="或：一句话故事想法" value={form.idea} onChange={(e) => setForm({ ...form, idea: e.target.value })} style={{ width: '100%' }} />
        <br /><br />
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

// ============ 项目工作区 ============
function ProjectView({ id, onBack }) {
  const [project, setProject] = useState(null);
  const [pview, setPview] = useState('chapters');
  const [events, setEvents] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [editOpen, setEditOpen] = useState(false);
  const [chapters, setChapters] = useState([]);
  const [cursor, setCursor] = useState(0);

  const loadProject = useCallback(async () => {
    const [p, j, c] = await Promise.all([api.get('/api/projects/' + id), api.get('/api/projects/' + id + '/jobs'), api.get('/api/projects/' + id + '/chapters')]);
    setProject(p); setJobs(j); setChapters(c); setCursor((x) => (x < 0 ? 0 : Math.min(x, Math.max(c.length - 1, 0))));
  }, [id]);
  useEffect(() => { loadProject(); }, [loadProject]);
  useEffect(() => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.projectId === id) { setEvents((e) => [...e.slice(-200), m]); if (m.status === 'done' || m.status === 'failed') loadProject(); }
      } catch {}
    };
    return () => ws.close();
  }, [id, loadProject]);

  async function run(chapter) { try { await api.post('/api/projects/' + id + '/run', chapter ? { chapter } : {}); setEvents([]); loadProject(); } catch (e) { alert(e.message); } }
  async function stop() { try { await api.post('/api/projects/' + id + '/stop'); loadProject(); } catch (e) { alert(e.message); } }

  if (!project) return <div className="muted">加载中…</div>;
  const running = project.status === 'running';

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <button onClick={onBack}>← 返回</button>
          <h2 style={{ margin: 0 }}>{project.name}</h2>
          <span className={'tag ' + (STATUS_TAG[project.status] || '')}>{project.status}</span>
          <button onClick={() => setEditOpen(true)}>⚙ 项目设置</button>
        </div>
      </div>

      <div className="tabs" style={{ marginTop: 12 }}>
        <button className={pview === 'chapters' ? 'active' : ''} onClick={() => setPview('chapters')}>📚 章节管理</button>
        <button className={pview === 'assets' ? 'active' : ''} onClick={() => setPview('assets')}>🎨 素材库</button>
        <button className={pview === 'generate' ? 'active' : ''} onClick={() => setPview('generate')}>🎬 生成内容</button>
        <button className={pview === 'exports' ? 'active' : ''} onClick={() => setPview('exports')}>🎞 成片</button>
      </div>

      <div style={{ marginTop: 16 }}>
        {pview === 'chapters' && <ChaptersView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} onRefresh={loadProject} />}
        {pview === 'generate' && <GenerateView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} events={events} jobs={jobs} running={running} onRun={run} onStop={stop} onRefresh={loadProject} />}
        {pview === 'assets' && <AssetsTab projectId={id} />}
        {pview === 'exports' && <ExportsTab projectId={id} />}
      </div>

      {editOpen && <EditProject project={project} onClose={() => setEditOpen(false)} onSaved={loadProject} />}
    </div>
  );
}

// ============ 页1 · 章节管理 ============
function ChaptersView({ projectId, chapters, cursor, setCursor, onRefresh }) {
  const cur = chapters[cursor] || chapters[0] || null;
  const [title, setTitle] = useState('');
  const [novel, setNovel] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (cur) { setTitle(cur.title); setNovel(cur.novel || ''); setDirty(false); } }, [cur && cur.id]);
  async function save() {
    try { await api.patch('/api/projects/' + projectId + '/chapters/' + cur.id, { title, novel }); alert('已保存「' + title + '」'); setDirty(false); onRefresh(); } catch (e) { alert(e.message); }
  }
  async function addChapter() {
    try { const c = await api.post('/api/projects/' + projectId + '/chapters', { title: '第' + (chapters.length + 1) + '章' }); onRefresh(); setCursor(Math.max(0, chapters.length)); } catch (e) { alert(e.message); }
  }
  async function removeChapter(c) {
    if (!window.confirm('删除「' + c.title + '」及其分镜？此操作不可逆。')) return;
    try { await api.del('/api/projects/' + projectId + '/chapters/' + c.id); onRefresh(); } catch (e) { alert(e.message); }
  }
  async function move(i, dir) {
    const target = i + dir; if (target < 0 || target >= chapters.length) return;
    const a = chapters[i], b = chapters[target];
    try { await api.patch('/api/projects/' + projectId + '/chapters/' + a.id, { seq: b.seq }); await api.patch('/api/projects/' + projectId + '/chapters/' + b.id, { seq: a.seq }); onRefresh(); } catch (e) { alert(e.message); }
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
              </div>
            )}
          </div>
        ))}
        {!chapters.length && <p className="muted">还没有章节，点「＋ 新增章节」。</p>}
      </div>
    </div>
  );
}

// ============ 页2 · 生成内容 ============
function GenerateView({ projectId, chapters, cursor, setCursor, events, jobs, running, onRun, onStop, onRefresh }) {
  const cur = chapters[cursor] || chapters[0] || null;
  async function regenChapter(mode) {
    if (!cur) return;
    const msg = mode === 'storyboard'
      ? '将清空「' + cur.title + '」当前的分镜，重新拆分并生成全部视频（素材保留）。确定继续？'
      : '将清空「' + cur.title + '」已生成的视频，按现有分镜重新生成全部视频（分镜与素材保留）。确定继续？';
    if (!window.confirm(msg)) return;
    try { await api.post('/api/projects/' + projectId + '/chapters/' + cur.id + '/regenerate' + (mode === 'storyboard' ? '?mode=full' : '')); onRun(cur.title); } catch (e) { alert(e.message); }
  }
  return (
    <div>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>生成内容</h2>
          <select value={cursor} onChange={(e) => setCursor(Number(e.target.value))}>
            {chapters.map((c, i) => <option key={c.id} value={i}>{c.title}</option>)}
          </select>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {running
            ? <button className="danger" onClick={onStop}>■ 停止</button>
            : <button className="primary" disabled={!cur} onClick={() => cur && onRun(cur.title)}>▶ 生成/继续 {cur ? cur.title : ''}</button>}
          {!running && <button onClick={() => onRun(null)}>生成全部章节</button>}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {!running && <button onClick={() => regenChapter('storyboard')} disabled={!cur}>↻ 重新生成分镜</button>}
          {!running && <button onClick={() => regenChapter('videos')} disabled={!cur}>↻ 重新生成视频</button>}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          点「生成/继续」就接着上次进度跑（已完成的素材/分镜/视频自动跳过），中断或失败后点它即可继续。
          「重新生成分镜」清空本章分镜、重新拆分并出视频（素材保留）。
          「重新生成视频」保留分镜，只重做本章全部视频。
        </p>
      </div>
      <details open style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>运行日志（生成进度）</summary>
        <ConsoleTab projectId={projectId} events={events} jobs={jobs} onRefresh={onRefresh} />
      </details>
      {cur && <ShotsTab projectId={projectId} chapter={cur.title} onRefresh={onRefresh} />}
    </div>
  );
}

// ============ 项目设置（名称/风格） ============
function EditProject({ project, onClose, onSaved }) {
  const [name, setName] = useState(project.name);
  const [style, setStyle] = useState(project.style || '');
  const [res, setRes] = useState(project.video_resolution || '480P');
  const [ratio, setRatio] = useState(project.video_aspect_ratio || '16:9');
  const [cw, setCw] = useState(project.video_width ? String(project.video_width) : '');
  const [ch, setCh] = useState(project.video_height ? String(project.video_height) : '');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/projects/' + project.id, {
        name, style,
        video_resolution: res,
        video_aspect_ratio: ratio,
        video_width: Number(cw) || 0,
        video_height: Number(ch) || 0,
      });
      alert('已保存'); onClose(); onSaved();
    }
    catch (e) { alert(e.message); }
    finally { setSaving(false); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>项目设置</h2>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名" style={{ flex: 1 }} />
          <input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="画面风格（国漫/3D/写实…）" style={{ flex: 1 }} />
        </div>
        <h3 style={{ margin: '14px 0 6px' }}>视频参数</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span className="muted">分辨率</span>
          <select value={res} onChange={(e) => setRes(e.target.value)}>
            {VIDEO_RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="muted">比例</span>
          <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
            {VIDEO_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {res === 'custom' && (
            <>
              <span className="muted">宽</span>
              <input type="number" min="64" step="32" value={cw} onChange={(e) => setCw(e.target.value)} placeholder="1024" style={{ width: 90 }} />
              <span className="muted">高</span>
              <input type="number" min="64" step="32" value={ch} onChange={(e) => setCh(e.target.value)} placeholder="576" style={{ width: 90 }} />
            </>
          )}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>章节与小说原文在「章节管理」页编辑；素材在「素材库」页管理（全项目共用）。</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={saving} onClick={save}>保存</button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ============ 控制台 ============
function ConsoleTab({ projectId, events, jobs, onRefresh }) {
  const [log, setLog] = useState('');
  const [fullLog, setFullLog] = useState(null);
  const [loadingLog, setLoadingLog] = useState(false);
  useEffect(() => {
    const lines = jobs.map((j) => '[' + j.status + '] ' + j.type + ' ' + (j.phase || '') + ' ' + (j.detail || '') + (j.error ? ' ERR:' + j.error : ''));
    const ev = events.map((m) => '▶ ' + (m.phase || '') + ' ' + (m.detail || '') + (m.status ? ' [' + m.status + ']' : ''));
    setLog([...lines, ...ev].join('\n'));
  }, [events, jobs]);
  async function viewFullLog() {
    const job = jobs[0];
    if (!job) return;
    setLoadingLog(true);
    try {
      const r = await api.get('/api/projects/' + projectId + '/jobs/' + job.id + '/log');
      setFullLog(r);
    } catch (e) { alert(e.message); }
    finally { setLoadingLog(false); }
  }
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>运行日志</h2>
        <div className="row">
          {jobs.length > 0 && <button onClick={viewFullLog} disabled={loadingLog}>{loadingLog ? '加载中…' : '查看完整日志'}</button>}
          <button onClick={onRefresh}>刷新</button>
        </div>
      </div>
      <pre className="logbox">{log || '（暂无日志，在「生成内容」页点击生成启动流水线）'}</pre>
      {fullLog && (
        <details open style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>完整日志（Agent 每一步工具调用 / 技能加载 / 模型输出）</summary>
          <pre className="logbox" style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{fullLog.text || '（空）'}</pre>
          <p className="muted" style={{ wordBreak: 'break-all' }}>日志文件：{fullLog.logPath || ''}</p>
        </details>
      )}
      <p className="muted">生成过程全自动、无需人工介入；一整章视频会逐镜串行生成，可长时间运行。结束后回到「生成内容」页复核每个镜头。</p>
    </div>
  );
}

// ============ 资产库 ============
function AssetsTab({ projectId }) {
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
    try { await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/design-voice'); alert('已提交音色设计，稍后在「生成内容」的运行日志查看进度'); load(); } catch (e) { alert(e.message); }
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

// ============ 分镜审查 ============
function ShotsTab({ projectId, chapter: chapterProp = '', onRefresh }) {
  const [shots, setShots] = useState([]);
  const [assets, setAssets] = useState([]);
  const [project, setProject] = useState(null);
  const [preview, setPreview] = useState(null);
  const [feedback, setFeedback] = useState({});
  const [zipping, setZipping] = useState(false);
  const load = useCallback(() => {
    api.get('/api/projects/' + projectId + '/shots').then(setShots).catch(alert);
    api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch(alert);
    api.get('/api/projects/' + projectId).then(setProject).catch(() => {});
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  const shown = chapterProp ? shots.filter((s) => (s.chapter || '默认') === chapterProp) : shots;
  const doneShots = shown.filter((s) => s.video_path && s.status === 'done');

  const byId = (id) => assets.find((a) => a.id === id);
  const asArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);
  const charsOf = (s) => asArr(s.character_ids).map(byId).filter(Boolean);
  const scenesOf = (s) => asArr(s.scene_ids).map(byId).filter(Boolean);
  const propsOf = (s) => asArr(s.prop_ids).map(byId).filter(Boolean);
  const costumesOf = (s) => asArr(s.costume_ids).map(byId).filter(Boolean);

  function RefThumb({ a }) {
    return (
      <div style={{ textAlign: 'center', width: 76 }}>
        {a.image_path
          ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={() => setPreview(a)} style={{ width: 64, height: 64, objectFit: 'cover', cursor: 'zoom-in' }} title="点击预览" />
          : <div className="thumb" style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>{a.category}</div>}
        <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.name}</div>
      </div>
    );
  }

  async function regen(shotId) {
    const fb = feedback[shotId] || undefined;
    try { await api.post('/api/projects/' + projectId + '/shots/' + shotId + '/regenerate', { feedback: fb }); alert('已提交重生成'); load(); } catch (e) { alert(e.message); }
  }
  async function exportChapter() {
    try {
      const r = await api.post('/api/projects/' + projectId + '/export', { chapter: chapterProp });
      const url = fileUrl(projectId, r.export_path);
      const a = document.createElement('a');
      a.href = url;
      a.download = (r.export_path || '').split('/').pop() || 'chapter.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      alert('导出成功，已开始下载。成片可到「🎞 成片」页预览和下载。');
      onRefresh();
    } catch (e) { alert(e.message); }
  }
  async function zipShots() {
    setZipping(true);
    try {
      const url = '/api/projects/' + projectId + '/shots/zip' + (chapterProp ? '?chapter=' + encodeURIComponent(chapterProp) : '');
      const res = await fetch(url);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + res.status));
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      let name = '视频片段.zip';
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="?([^";]+)"?/i.exec(cd);
      if (star) name = decodeURIComponent(star[1]);
      else if (plain) name = plain[1];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { alert('打包失败：' + e.message); }
    finally { setZipping(false); }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <h2>分镜审查（{chapterProp ? chapterProp + ' · ' : ''}共 {shown.length} 镜）</h2>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={exportChapter} disabled={!shown.length}>导出本章成片</button>
          <button onClick={zipShots} disabled={!doneShots.length || zipping}>{zipping ? '打包中…' : '📦 打包下载片段'}</button>
        </div>
      </div>
      {shown.map((s) => {
        const chars = charsOf(s), scenes = scenesOf(s), props = propsOf(s), costumes = costumesOf(s);
        // 语音参考只显示「有台词」角色（与后端 assembleShotReferences 一致）：多人同场时仅说话角色才有音色
        const speakers = dialogueSpeakers(s.dialogue);
        const speakingChars = chars.filter((c) => speakers.some((sp) => sp === c.name || sp.includes(c.name) || c.name.includes(sp)));
        const voices = speakingChars.filter((c) => c.voice_ref).map((c) => ({ name: c.name, voice_ref: c.voice_ref }));
        const allRefs = [...chars, ...scenes, ...props, ...costumes];
        const resoLabel = s.resolution === 'custom' && project
          ? 'custom ' + (project.video_width || '?') + '×' + (project.video_height || '?')
          : (s.resolution || '480P');
        return (
          <div className="card" key={s.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>分镜 {s.idx}{s.chapter ? ' · ' + s.chapter : ''} · {s.scene_name || '未命名'}</b>
              <span className={'tag ' + (STATUS_TAG[s.status] || '')}>{s.status}</span>
            </div>
            <div className="muted">时长 {s.duration}s · 分辨率 {resoLabel} · 比例 {s.aspect_ratio || '16:9'} · seed {s.seed || '-'}</div>

            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ marginBottom: 4 }}>参考素材（角色 / 场景 / 道具 / 服装 / 语音〔仅台词角色〕）</div>
              {allRefs.length || voices.length ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  {chars.map((a) => <RefThumb key={a.id} a={a} />)}
                  {scenes.map((a) => <RefThumb key={a.id} a={a} />)}
                  {props.map((a) => <RefThumb key={a.id} a={a} />)}
                  {costumes.map((a) => <RefThumb key={a.id} a={a} />)}
                  {voices.map((v, i) => (
                    <div key={i} style={{ textAlign: 'center', width: 190 }}>
                      <audio controls src={fileUrl(projectId, v.voice_ref)} style={{ width: '100%', height: 38 }} title="角色参考音色" />
                      <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{v.name}</div>
                    </div>
                  ))}
                </div>
              ) : <span className="muted">（无）</span>}
            </div>

            <details open style={{ marginTop: 8 }}>
              <summary>提示词 & 分镜脚本</summary>
              <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                {s.camera && <div><b>镜头：</b>{s.camera}</div>}
                {s.visual && <div><b>画面：</b>{s.visual}</div>}
                {s.dialogue && <div><b>台词：</b>{s.dialogue}</div>}
                {s.narration && <div><b>旁白：</b>{s.narration}</div>}
                {s.sub_shots && <div><b>子镜头：</b><pre style={{ whiteSpace: 'pre-wrap' }}>{s.sub_shots}</pre></div>}
              </div>
              <div style={{ marginTop: 6 }}>
                <b>视频提示词：</b>
                <pre className="logbox" style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{s.video_prompt || '（未生成）'}</pre>
              </div>
              {s.prompt_id && <div className="muted">ComfyUI prompt_id: {s.prompt_id}</div>}
            </details>

            {s.video_path && <video className="video" controls src={fileUrl(projectId, s.video_path)} />}
            {s.error && <p style={{ color: '#ff8080' }}>错误：{s.error}</p>}
            <div className="row" style={{ marginTop: 8 }}>
              <input placeholder="反馈（如：镜头拉近 / 让人物微笑），留空则换种子重生成" value={feedback[s.id] || ''} onChange={(e) => setFeedback({ ...feedback, [s.id]: e.target.value })} style={{ flex: 1 }} />
              <button onClick={() => regen(s.id)}>↻ 重新生成</button>
            </div>
          </div>
        );
      })}
      {!shots.length && <p className="muted">暂无分镜</p>}
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

// ============ 成片（导出视频） ============
function ExportsTab({ projectId }) {
  const [files, setFiles] = useState([]);
  const load = useCallback(() => api.get('/api/projects/' + projectId + '/exports').then((r) => setFiles(r.files || [])).catch(alert), [projectId]);
  useEffect(() => { load(); }, [load]);

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(ms) { try { return new Date(ms).toLocaleString('zh-CN'); } catch { return ''; } }
  function download(f) {
    const a = document.createElement('a');
    a.href = '/api/projects/' + projectId + '/exports/' + encodeURIComponent(f.name) + '/download';
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>成片（{files.length}）</h2>
        <button onClick={load}>刷新</button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        在「生成内容」页点「导出本章成片」后，合并好的最终视频会出现在这里，可在线预览或下载。
      </p>
      {!files.length && <p className="muted">暂无成片，请先在「生成内容」页完成某章并点击「导出本章成片」。</p>}
      {files.map((f) => (
        <div key={f.rel} className="card" style={{ marginTop: 12, background: '#10131a' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b style={{ wordBreak: 'break-all' }}>{f.name}</b>
            <div className="row" style={{ gap: 8 }}>
              <span className="muted">{fmtBytes(f.size)} · {fmtTime(f.mtime)}</span>
              <button className="primary" onClick={() => download(f)}>⬇ 下载</button>
            </div>
          </div>
          <video className="video" controls preload="metadata" src={f.url} style={{ maxHeight: 420, marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

// ============ 技能 ============
function SkillsTab() {
  const [skills, setSkills] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const load = useCallback(() => api.get('/api/skills').then(setSkills).catch(alert), []);
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
      alert('已安装技能：' + (j.installed || []).map((s) => s.name).join('、'));
      load();
    } catch (e) { alert('上传失败：' + e.message); }
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

// ============ 工作流（仅展示系统已注册） ============
function WorkflowsTab() {
  const [workflows, setWorkflows] = useState([]);
  const load = useCallback(() => api.get('/api/workflows').then(setWorkflows).catch(alert), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <h2>已注册工作流</h2>
      {workflows.map((w) => (
        <div key={w.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #232936' }}>
          <div><b>{w.name}</b> <span className="tag">{w.kind}</span> <span className="muted">{w.sourceFile}</span></div>
        </div>
      ))}
      {!workflows.length && <p className="muted">暂无已注册工作流</p>}
    </div>
  );
}

// ============ 设置 ============
function SettingsPage({ onBack }) {
  const [cfg, setCfg] = useState(null);
  const [test, setTest] = useState('');
  useEffect(() => { api.get('/api/config').then(setCfg).catch(alert); }, []);
  async function save() {
    try { await api.put('/api/config', cfg); alert('已保存'); } catch (e) { alert(e.message); }
  }
  async function testComfy() {
    try { const r = await api.post('/api/comfyui/test', { baseUrl: cfg.comfyui.baseUrl }); setTest(r.ok ? ('连接成功 · ' + r.system + ' · ' + r.device) : ('连接失败：' + r.error)); } catch (e) { setTest('失败：' + e.message); }
  }
  if (!cfg) return <div className="muted">加载中…</div>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>设置</h2><button onClick={onBack}>返回</button></div>
      <h3>ComfyUI 服务</h3>
      <div className="row">
        <input style={{ flex: 1 }} value={cfg.comfyui.baseUrl} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, baseUrl: e.target.value } })} />
        <button onClick={testComfy}>测试连接</button>
        {test && <span className="muted">{test}</span>}
      </div>
      <h3>LLM（Agent 大脑，OpenAI 兼容）</h3>
      <div className="row">
        <input style={{ flex: 2 }} placeholder="Base URL（需 /v1 结尾）" value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} />
        <input style={{ flex: 1 }} placeholder="模型" value={cfg.llm.model} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })} />
      </div>
      <br />
      <input style={{ width: '100%' }} placeholder="API Key" type="password" value={cfg.llm.apiKey} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })} />
      <label className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!cfg.llm.vision} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, vision: e.target.checked } })} />
        <span>支持图片输入（多模态/视觉模型）</span>
      </label>
      <p className="muted" style={{ marginTop: 4 }}>开启后，写分镜/图生图提示词时会把参考图提交给大模型；请确认所用模型确实支持视觉输入。</p>
      <br />
      <button className="primary" onClick={save}>保存配置</button>

      <h3 style={{ marginTop: 24 }}>技能库<span className="muted">（全局 · 所有项目共用）</span></h3>
      <SkillsTab />
      <h3>工作流库<span className="muted">（全局 · 所有项目共用）</span></h3>
      <WorkflowsTab />
    </div>
  );
}
