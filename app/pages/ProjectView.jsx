'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import { STATUS_TAG } from './shared';
import { useToast } from '../toast';
import ChaptersView from './ChaptersView';
import GenerateView from './GenerateView';
import AssetsTab from './AssetsTab';
import ExportsTab from './ExportsTab';
import ConsoleTab from './ConsoleTab';
import EditProject from './EditProject';

// ============ 项目工作区 ============
export default function ProjectView({ id, onBack, initialTab = 'chapters', onTabChange }) {
  const toast = useToast();
  const [project, setProject] = useState(null);
  const [pview, setPview] = useState(initialTab);
  // tab 切换同步到 URL（page.jsx replaceState 更新，刷新后停留原 tab）
  const setTab = (t) => { setPview(t); if (onTabChange) onTabChange(t); };
  const [events, setEvents] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [editOpen, setEditOpen] = useState(false);
  const [chapters, setChapters] = useState([]);
  const [cursor, setCursor] = useState(0);

  const loadProject = useCallback(async () => {
    const [p, j, c] = await Promise.all([api.get('/api/projects/' + id), api.get('/api/projects/' + id + '/jobs'), api.get('/api/projects/' + id + '/chapters')]);
    setProject(p); setJobs(j); setChapters(c); setCursor((x) => (x < 0 ? 0 : Math.min(x, Math.max(c.length - 1, 0))));
  }, [id]);

  // WS 自动重连：断开后指数退避重连（1s→2s→…→15s），重连成功先整页刷新一次，
  // 否则 ComfyUI/服务重启一次，前端就永远停在旧状态，只能靠手刷页面恢复。
  useEffect(() => {
    let closed = false; let ws = null; let timer = null; let delay = 1000;
    const connect = () => {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => { delay = 1000; loadProject(); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.projectId === id) { setEvents((e) => [...e.slice(-200), m]); if (m.status === 'done' || m.status === 'failed') loadProject(); }
        } catch {}
      };
      ws.onclose = () => {
        if (closed) return;
        loadProject();
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); if (ws) { try { ws.close(); } catch {} } };
  }, [id, loadProject]);

  // 运行中轮询兜底：WS 那条「完成」广播一旦丢了，停止按钮就永远红着。
  // 每 2.5s 拉一次 /projects/:id，running 消失即自动恢复；任务完成后轮询自然停止。
  useEffect(() => {
    if (project?.status !== 'running') return;
    const t = setInterval(() => loadProject(), 2500);
    return () => clearInterval(t);
  }, [project?.status, loadProject]);

  useEffect(() => { loadProject(); }, [loadProject]);

  async function run(chapter) { try { await api.post('/api/projects/' + id + '/run', chapter ? { chapter } : {}); setEvents([]); loadProject(); } catch (e) { toast.error(e.message); } }
  async function stop() { try { await api.post('/api/projects/' + id + '/stop'); loadProject(); } catch (e) { toast.error(e.message); } }

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
        <button className={pview === 'chapters' ? 'active' : ''} onClick={() => setTab('chapters')}>📚 章节管理</button>        
        <button className={pview === 'generate' ? 'active' : ''} onClick={() => setTab('generate')}>🎬 生成内容</button>
        <button className={pview === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>🎨 素材库</button>
        <button className={pview === 'exports' ? 'active' : ''} onClick={() => setTab('exports')}>🎞 成片</button>
        <button className={pview === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>📜 运行日志</button>
      </div>

      <div style={{ marginTop: 16 }}>
        {pview === 'chapters' && <ChaptersView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} onRefresh={loadProject} />}
        {pview === 'generate' && <GenerateView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} running={running} onRun={run} onStop={stop} onRefresh={loadProject} onGoLogs={() => setTab('logs')} />}
        {pview === 'assets' && <AssetsTab projectId={id} running={running} />}
        {pview === 'exports' && <ExportsTab projectId={id} />}
        {pview === 'logs' && <ConsoleTab projectId={id} events={events} jobs={jobs} onRefresh={loadProject} />}
      </div>

      {editOpen && <EditProject project={project} onClose={() => setEditOpen(false)} onSaved={loadProject} />}
    </div>
  );
}