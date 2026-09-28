'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import { STATUS_TAG } from './shared';
import ChaptersView from './ChaptersView';
import GenerateView from './GenerateView';
import AssetsTab from './AssetsTab';
import ExportsTab from './ExportsTab';
import ConsoleTab from './ConsoleTab';
import EditProject from './EditProject';

// ============ 项目工作区 ============
export default function ProjectView({ id, onBack }) {
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
        <button className={pview === 'generate' ? 'active' : ''} onClick={() => setPview('generate')}>🎬 生成内容</button>
        <button className={pview === 'assets' ? 'active' : ''} onClick={() => setPview('assets')}>🎨 素材库</button>
        <button className={pview === 'exports' ? 'active' : ''} onClick={() => setPview('exports')}>🎞 成片</button>
        <button className={pview === 'logs' ? 'active' : ''} onClick={() => setPview('logs')}>📜 运行日志</button>
      </div>

      <div style={{ marginTop: 16 }}>
        {pview === 'chapters' && <ChaptersView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} onRefresh={loadProject} />}
        {pview === 'generate' && <GenerateView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} running={running} onRun={run} onStop={stop} onRefresh={loadProject} />}
        {pview === 'assets' && <AssetsTab projectId={id} />}
        {pview === 'exports' && <ExportsTab projectId={id} />}
        {pview === 'logs' && <ConsoleTab projectId={id} events={events} jobs={jobs} onRefresh={loadProject} />}
      </div>

      {editOpen && <EditProject project={project} onClose={() => setEditOpen(false)} onSaved={loadProject} />}
    </div>
  );
}