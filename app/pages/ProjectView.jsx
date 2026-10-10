'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Button, Chip, Tabs, Tab, Card, CardBody, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { statusColor } from './shared';
import { useToast } from '../toast';
import ChaptersView from './ChaptersView';
import GenerateView from './GenerateView';
import AssetsTab from './AssetsTab';
import ExportsTab from './ExportsTab';
import ConsoleTab from './ConsoleTab';
import EditProject from './EditProject';

// 任务类型 → 中文名（任务列表显示用）
const JOB_LABEL = { create: '生成流水线', regenerate: '重生成分镜', 'asset-image': '资产出图', 'voice-design': '音色设计', costume: '换装', age: '年龄变体', stage: '阶段运行', 'chapter-video': '章节视频重生成', llm: '素材命名（LLM）', export: '导出成片' };
// 可取消的任务类型（走队列/闸门，能被打断）；llm/export 是请求内同步任务，无取消入口
const CANCELLABLE = new Set(['create', 'regenerate', 'asset-image', 'voice-design', 'costume', 'age', 'stage', 'chapter-video']);
// 任务状态 → 标签与颜色
const JOB_STATUS = {
  running: { label: '执行中', color: 'primary' },
  queued: { label: '排队中', color: 'warning' },
  done: { label: '完成', color: 'success' },
  failed: { label: '失败', color: 'danger' },
  cancelled: { label: '已取消', color: 'default' },
  interrupted: { label: '已中断', color: 'default' },
};

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
  const [queueOpen, setQueueOpen] = useState(false);
  // 任务终态通知去重（jobId+status），避免同一任务重复广播导致刷屏
  const notifiedRef = useRef(new Set());
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
    // 任务状态通知：完成 / 失败 / 取消时弹 toast（去重）
    const notify = (m) => {
      const st = m.status;
      if (st !== 'done' && st !== 'failed' && st !== 'cancelled') return;
      if (m.type === 'llm') return; // 素材命名等 LLM 内联子任务不弹通知，避免刷屏（仍出现在任务列表）
      const key = m.jobId + ':' + st;
      if (notifiedRef.current.has(key)) return;
      notifiedRef.current.add(key);
      const label = JOB_LABEL[m.type] || m.type || '任务';
      if (st === 'done') toast.success('✅ 任务完成：' + label);
      else if (st === 'failed') toast.error('❌ 任务失败：' + label + (m.detail ? ' — ' + String(m.detail).slice(0, 80) : ''));
      else toast.info('⏹ 任务已取消：' + label);
    };
    const connect = () => {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => { delay = 1000; loadProject(); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.projectId !== id) return;
          setEvents((e) => [...e.slice(-200), m]);
          if (m.status) loadProject();
          notify(m);
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
  async function cancelJob(jid) { try { await api.post('/api/projects/' + id + '/jobs/' + jid + '/cancel'); loadProject(); } catch (e) { toast.error(e.message); } }
  const running = project?.status === 'running';
  // 活动任务 = 正在执行 + 排队中（供任务队列面板与各 Tab 的按条目状态使用）
  const activeJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const runningCount = activeJobs.filter((j) => j.status === 'running').length;
  const queuedCount = activeJobs.filter((j) => j.status === 'queued').length;
  // 任务列表：展示全部任务（含已完成/失败，最新在前，最多 30 条）——用户提交的任何任务都应可见
  const recentJobs = jobs.slice(0, 30);

  if (!project) {
    return (
      <Card>
        <CardBody className="flex-row items-center justify-center gap-2.5 py-10">
          <Spinner size="sm" />
          <span className="muted">项目加载中…</span>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="row justify-between">
        <div className="row">
          <Button size="sm" variant="flat" onPress={onBack}>← 返回</Button>
          <h2 className="text-lg font-semibold m-0">{project.name}</h2>
          <Chip size="sm" variant="flat" color={statusColor(project.status)}>{project.status}</Chip>
          {/* 任务队列入口：常驻徽标，显示执行中+排队中任务数，点击展开/收起队列 */}
          <Button
            size="sm"
            variant={queueOpen ? 'solid' : 'flat'}
            color={activeJobs.length > 0 ? 'warning' : 'default'}
            onPress={() => setQueueOpen((v) => !v)}
          >
            📋 任务 {activeJobs.length}
          </Button>
          <Button size="sm" variant="flat" onPress={() => setEditOpen(true)}>⚙ 项目设置</Button>
        </div>
      </div>

      {/* 任务列表：所有 Tab 通用，列出全部任务（含已完成/失败），活动任务可逐个取消或全部停止 */}
      {queueOpen && (
        <Card>
          <CardBody className="gap-2">
            <div className="row justify-between items-center">
              <b>任务列表（{runningCount} 执行中{queuedCount ? ' · ' + queuedCount + ' 排队中' : ''} · 共 {jobs.length} 条）</b>
              {activeJobs.length > 0 && <Button size="sm" color="danger" variant="flat" onPress={stop}>■ 全部停止</Button>}
            </div>
            {recentJobs.length === 0 ? (
              <div className="muted">暂无任务</div>
            ) : (
              <div className="flex flex-col gap-1">
                {recentJobs.map((j) => {
                  const st = JOB_STATUS[j.status] || { label: j.status, color: 'default' };
                  const isActive = j.status === 'running' || j.status === 'queued';
                  return (
                    <div key={j.id} className="row justify-between items-center">
                      <span className="muted" style={{ wordBreak: 'break-all' }}>
                        <Chip size="sm" variant="flat" color={st.color} className="mr-1.5">{st.label}</Chip>
                        {JOB_LABEL[j.type] || j.type}{j.phase ? ' · ' + j.phase : ''}{j.error ? ' — ' + j.error : ''}
                      </span>
                      {isActive && CANCELLABLE.has(j.type) && <Button size="sm" variant="light" onPress={() => cancelJob(j.id)}>取消</Button>}
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      )}

<Tabs aria-label="项目工作区" selectedKey={pview} onSelectionChange={setTab} variant="underlined">
        <Tab key="chapters" title="📚 章节管理" />
        <Tab key="generate" title="🎬 生成内容" />
        <Tab key="assets" title="🎨 素材库" />
        <Tab key="exports" title="🎞 成片" />
        <Tab key="logs" title="📜 运行日志" />
      </Tabs>

      <div>
        {pview === 'chapters' && <ChaptersView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} onRefresh={loadProject} />}
        {pview === 'generate' && <GenerateView projectId={id} chapters={chapters} cursor={cursor} setCursor={setCursor} running={running} jobs={jobs} onRun={run} onStop={stop} onRefresh={loadProject} onGoLogs={() => setTab('logs')} />}
        {pview === 'assets' && <AssetsTab projectId={id} running={running} jobs={jobs} />}
        {pview === 'exports' && <ExportsTab projectId={id} />}
        {pview === 'logs' && <ConsoleTab projectId={id} events={events} jobs={jobs} onRefresh={loadProject} />}
      </div>

      {editOpen && <EditProject project={project} onClose={() => setEditOpen(false)} onSaved={loadProject} />}
    </div>
  );
}