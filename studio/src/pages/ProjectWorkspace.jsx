import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Clapperboard,
  ClipboardList,
  Film,
  Lock,
  Music4,
  Palette,
  ScrollText,
  Settings2,
  Square,
  Workflow,
} from 'lucide-react';
import { api, setReadOnlyMode } from '../lib/api.js';
import { requireAuth } from '../lib/auth-gate.js';
import { getSessionToken } from '../lib/session.js';
import { getAuthToken } from '../lib/auth.js';
import { JOB_LABEL, STATUS_TEXT } from '../lib/format.js';
import { Button, Spinner, StatusPill } from '../components/ui.jsx';
import TaskDrawer from '../components/TaskDrawer.jsx';
import ProjectSettingsDialog from '../components/ProjectSettingsDialog.jsx';
import { MetaItem, RatioMeta, ResolutionMeta } from '../components/visuals.jsx';
import ProgressPanel from '../components/ProgressPanel.jsx';
import { useToast } from '../components/toast.jsx';
import { useProjectProgress } from '../lib/hooks.js';
import ChaptersPage from './ChaptersPage.jsx';
import AssetsPage from './AssetsPage.jsx';
import ShotsPage from './ShotsPage.jsx';
import MusicPage from './MusicPage.jsx';
import ExportsPage from './ExportsPage.jsx';
import LogsPage from './LogsPage.jsx';
import WorkflowPage from './WorkflowPage.jsx';

const TABS = [
  { key: 'workflow', label: '流程', icon: Workflow },
  { key: 'chapters', label: '章节管理', icon: BookOpen },
  { key: 'assets', label: '素材库', icon: Palette },
  { key: 'shots', label: '分镜审查', icon: Clapperboard },
  { key: 'music', label: '背景音乐', icon: Music4 },
  { key: 'exports', label: '成片', icon: Film },
  { key: 'logs', label: '运行日志', icon: ScrollText },
];

const QUEUE_KIND_LABEL = {
  t2i: '资产图', i2i: '资产图', image: '资产图',
  r2v: '分镜视频', i2v: '分镜视频', video: '分镜视频',
  tts: '音色', voice: '音色', music: '背景音乐', export: '合成/导出',
};

export default function ProjectWorkspace({ id, initialTab = 'chapters', onBack, onTabChange, guest = false, auth = null, features = {} }) {
  const toast = useToast();
  const [project, setProject] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [pview, setPview] = useState(initialTab === 'generate' ? 'chapters' : initialTab);
  const [cursorId, setCursorId] = useState('');
  const [queueOpen, setQueueOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { progress, refreshProgress } = useProjectProgress(id, project?.status === 'running');

  // 渲染队列快照：面板打开时轮询「排在第几位 / 预计多久」，关闭时不请求。
  const [queue, setQueue] = useState(null);
  // 任务抽屉打开或项目运行中都要拉队列：运行中用于页面顶部展示“当前真实在渲染的子任务”。
  useEffect(() => {
    if (!queueOpen && project?.status !== 'running') {
      setQueue(null);
      return;
    }
    let alive = true;
    const pull = () =>
      api
        .get('/api/queue')
        .then((q) => {
          if (alive) setQueue(q);
        })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [queueOpen, project?.status]);

  const notifiedRef = useRef(new Set());
  const removedJobIdsRef = useRef(new Set());
  const firstJobsLoadRef = useRef(true);
  const seenJobIdsRef = useRef(new Set());
  const loadSeqRef = useRef(0);
  const prevActiveRef = useRef(0);

  const loadProject = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    let p, j, c;
    try {
      [p, j, c] = await Promise.all([
        api.get('/api/projects/' + id),
        api.get('/api/projects/' + id + '/jobs'),
        api.get('/api/projects/' + id + '/chapters'),
      ]);
    } catch (e) {
      if (seq === loadSeqRef.current) setLoadError(e.message || '加载失败');
      return;
    }
    if (seq !== loadSeqRef.current) return;
    setLoadError('');
    // 数据没变就复用旧引用：轮询每 2.5s 一次，无条件 setState 会让整页（含分镜视频）反复重渲染。
    // 项目/章节在生成期间几乎不变，这里能省掉大部分无意义渲染。
    setProject((prev) => (JSON.stringify(prev) === JSON.stringify(p) ? prev : p));
    setJobs((prev) => (JSON.stringify(prev) === JSON.stringify(j) ? prev : j));
    setChapters((prev) => (JSON.stringify(prev) === JSON.stringify(c) ? prev : c));
    setCursorId((x) => (c.some((ch) => ch.id === x) ? x : c.length ? c[c.length - 1].id : ''));
    if (firstJobsLoadRef.current) firstJobsLoadRef.current = false;
    else if (j.some((x) => !seenJobIdsRef.current.has(x.id))) setQueueOpen(true);
    seenJobIdsRef.current = new Set(j.map((x) => x.id));
  }, [id]);

  useEffect(() => {
    let closed = false;
    let ws = null;
    let timer = null;
    let delay = 1000;

    const notify = (m) => {
      const st = m.status;
      if (st !== 'done' && st !== 'failed' && st !== 'cancelled') return;
      if (m.type === 'llm') return;
      const key = m.jobId + ':' + st;
      if (removedJobIdsRef.current.has(m.jobId)) return;
      if (notifiedRef.current.has(key)) return;
      notifiedRef.current.add(key);
      const label = JOB_LABEL[m.type] || m.type || '任务';
      if (st === 'done') toast.success('任务完成：' + label);
      else if (st === 'failed') toast.error('任务失败：' + label + (m.detail ? ' — ' + String(m.detail).slice(0, 90) : ''));
      else toast.info('任务已取消：' + label);
    };

    const connect = () => {
      const auth = getAuthToken();
      const session = getSessionToken();
      const qs = [auth ? 'token=' + encodeURIComponent(auth) : '', session ? 'session=' + encodeURIComponent(session) : ''].filter(Boolean).join('&');
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (qs ? '?' + qs : ''));
      let loadPending = false;
      ws.onopen = () => {
        delay = 1000;
        loadProject();
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.projectId !== id) return;
          setEvents((e) => [...e.slice(-200), m]);
          // 进度消息可能很密集（逐镜/逐资产各一条）：合并成最多每 400ms 一次全量刷新，
          // 否则每来一条就重拉 项目+任务+章节，整页（含分镜视频）跟着连续重渲染。
          if (!loadPending) {
            loadPending = true;
            setTimeout(() => {
              loadPending = false;
              loadProject();
            }, 400);
          }
          notify(m);
        } catch {
          /* 忽略非 JSON 心跳 */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        loadProject();
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }, [id, loadProject, toast]);

  useEffect(() => {
    if (project?.status !== 'running') return;
    const t = setInterval(() => loadProject(), 2500);
    return () => clearInterval(t);
  }, [project?.status, loadProject]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  async function run(chapter) {
    await api.post('/api/projects/' + id + '/run', chapter ? { chapter } : {});
    setEvents([]);
    loadProject();
    refreshProgress();
  }

  async function stop(chapter) {
    try {
      await api.post('/api/projects/' + id + '/stop', chapter ? { chapter } : {});
      loadProject();
      refreshProgress();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function cancelJob(jid) {
    try {
      await api.post('/api/projects/' + id + '/jobs/' + jid + '/cancel');
      loadProject();
      refreshProgress();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function removeJob(jid) {
    removedJobIdsRef.current.add(jid);
    try {
      await api.del('/api/projects/' + id + '/jobs/' + jid);
      loadProject();
      refreshProgress();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function clearFinished() {
    if (!(await toast.confirm('清除所有已结束的任务记录？（不影响素材 / 成片）', { danger: true }))) return;
    try {
      for (const j of jobs) if (j.status !== 'running' && j.status !== 'queued') removedJobIdsRef.current.add(j.id);
      const r = await api.del('/api/projects/' + id + '/jobs');
      toast.success('已清除 ' + ((r && r.removed) || 0) + ' 条任务记录');
      loadProject();
      refreshProgress();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const running = project?.status === 'running';
  const activeJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const runningCount = activeJobs.filter((j) => j.status === 'running').length;
  const queuedCount = activeJobs.filter((j) => j.status === 'queued').length;
  const finishedJobs = jobs.filter((j) => j.status !== 'running' && j.status !== 'queued');
  // 任务详情（detail/phase）更新很频繁，但分镜/素材页只关心「某个对象有没有活动任务」。
  // 按「id+状态+对象」签名复用引用，避免每个进度更新都把整张分镜表重渲染一遍。
  const jobsSig = jobs.map((j) => j.id + ':' + j.status + ':' + ((j.checkpoint && j.checkpoint.subject) || '')).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jobsForSubject = useMemo(() => jobs, [jobsSig]);
  const runningChapter = (jobs.find((j) => j.status === 'running' && j.checkpoint && j.checkpoint.chapter) || {}).checkpoint?.chapter || null;
  // 多章节并行：每个章节各自判断是否在跑。没有 chapter 的 create/stage 任务覆盖全部章节。
  const runningChapters = new Set();
  for (const j of activeJobs) {
    const ch = j.checkpoint && j.checkpoint.chapter;
    if (ch) runningChapters.add(ch);
    else if (j.type === 'create' || j.type === 'stage') {
      for (const c of chapters) runningChapters.add(c.title);
    }
  }
  const runningJob = activeJobs.find((j) => j.status === 'running') || activeJobs[0] || null;

  const shownJobs = [
    ...activeJobs.sort(
      (a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || (a.startedAt || 0) - (b.startedAt || 0),
    ),
    ...finishedJobs.slice(0, 20),
  ];
  // 细粒度活动：队列条目是“真正在渲染”的那一步；没有队列条目时退到 job 的当前阶段。
  const projectQueue = (queue?.items?.length ? queue.items : queue?.mine || []).filter((it) => it.projectId === id);
  const liveRunning = projectQueue.filter((it) => it.status === 'running');
  const liveWaiting = projectQueue.filter((it) => it.status !== 'running');
  const queueSubject = (it) => it.subject || it.payload?.subject || QUEUE_KIND_LABEL[it.kind] || it.kind || '渲染任务';
  const queueLabel = (it) => {
    const parts = [it.chapter || it.payload?.chapter, queueSubject(it)].filter(Boolean);
    return parts.length ? parts.join(' · ') : '渲染任务';
  };
  const activityFor = (j) => liveRunning.find((it) => it.jobId === j.id);

  useEffect(() => {
    if (activeJobs.length > 0 && prevActiveRef.current === 0) setQueueOpen(true);
    prevActiveRef.current = activeJobs.length;
  }, [activeJobs.length]);

  const setTab = (t) => {
    if (t === 'shots') setCursorId(chapters.length ? chapters[chapters.length - 1].id : '');
    setPview(t);
    if (onTabChange) onTabChange(t);
  };

  // 只读判定：访客，或当前用户不是该项目的归属人（管理员项目 = 展示库）
  const readOnly = guest || (!!auth?.authEnabled && !!project?.owner_id && auth?.user?.id !== project.owner_id && auth?.user?.role !== 'admin');
  // 功能权限（角色 + 逐用户开关）；admin 由后端保证全为 true
  const perms = auth?.user?.permissions || null;
  const canEdit = !readOnly && (!perms || perms.edit !== false);
  const canGenerate = !readOnly && (!perms || perms.generate !== false);
  const canExport = !readOnly && (!perms || perms.export !== false);
  useEffect(() => {
    // 前端兜底：只读期间任何写请求直接拒绝（服务端还会再拦一次）
    setReadOnlyMode(readOnly);
    return () => setReadOnlyMode(false);
  }, [readOnly]);

  // 只读预览隐藏「流程 / 运行日志」：日志含 Agent 每一步工具调用与模型输出，不属于展示内容。
  // 后台还可以逐项隐藏 Tab（features.tabs）；隐藏后接口仍受角色/权限校验。
  const featureTabs = features?.tabs || {};
  const visibleTabs = TABS.filter((t) => featureTabs[t.key] !== false).filter(
    (t) => !readOnly || (t.key !== 'workflow' && t.key !== 'logs'),
  );
  const tabKeySig = visibleTabs.map((t) => t.key).join(',');
  useEffect(() => {
    if (!visibleTabs.some((t) => t.key === pview)) {
      setPview(visibleTabs[0]?.key || 'chapters');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKeySig, pview]);

  if (!project) {
    return (
      <div className="panel flex flex-col items-center justify-center gap-3 px-6 py-16">
        {loadError ? (
          <>
            <p className="m-0 text-[12.5px] text-[var(--fg-3)]">
              {guest ? '该项目不可公开预览，登录后如果是你的项目即可查看。' : '项目加载失败：' + loadError}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="md" onClick={onBack}>
                返回项目列表
              </Button>
              {guest ? (
                <Button variant="primary" size="md" onClick={() => requireAuth('登录后即可查看该项目')}>
                  登录
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <Spinner size={18} />
            <span className="text-[12px] text-[var(--fg-3)]">项目加载中…</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex animate-fade-up flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Button variant="ghost" size="icon" aria-label="返回项目列表" onClick={onBack}>
            <ArrowLeft size={16} />
          </Button>
          <div className="min-w-0">
            <p className="eyebrow">Project</p>
            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 truncate text-[24px] font-semibold tracking-[-.02em] text-[var(--fg)]">{project.name}</h1>
              <StatusPill status={project.status}>{STATUS_TEXT[project.status] || project.status}</StatusPill>
            </div>
            <p className="m-0 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--fg-3)]">
              <MetaItem icon={BookOpen}>{chapters.length} 章</MetaItem>
              {project.style ? <MetaItem icon={Palette}>{project.style}</MetaItem> : null}
              <ResolutionMeta resolution={project.video_resolution} width={project.video_width} height={project.video_height} />
              <RatioMeta ratio={project.video_aspect_ratio} />
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {features?.taskDrawer === false ? null : (
            <Button variant={queueOpen ? 'secondary' : 'ghost'} size="sm" onClick={() => setQueueOpen((v) => !v)}>
              <ClipboardList size={14} />
              任务
              <span
                className={clsx(
                  'ml-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10px]',
                  activeJobs.length ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]' : 'bg-white/[0.06] text-[var(--fg-3)]',
                )}
              >
                {activeJobs.length}
              </span>
            </Button>
          )}
          {canEdit && features?.buttons?.projectSettings !== false ? (
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>
              <Settings2 size={14} />
              项目设置
            </Button>
          ) : null}
        </div>
      </header>

      {readOnly ? (
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[rgba(232,177,92,.28)] bg-[rgba(232,177,92,.06)] px-3.5 py-2.5">
          <span className="flex items-center gap-2 text-[12px] text-[var(--fg-2)]">
            <Lock size={13} className="text-[var(--accent)]" />
            {guest ? '只读预览 · 登录后可以创建并生成自己的作品' : '展示项目 · 只读，不能修改或生成'}
          </span>
          {guest ? (
            <Button variant="secondary" size="sm" onClick={() => requireAuth('登录后即可创建自己的项目')}>
              登录
            </Button>
          ) : null}
        </div>
      ) : null}

      {activeJobs.length ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-[color-mix(in_srgb,var(--accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-3.5 py-2.5">
          <span className="text-[10.5px] font-medium text-[var(--accent)]">当前执行</span>
          {activeJobs.map((j) => {
            const qi = activityFor(j);
            const chapter = j.checkpoint?.chapter || qi?.chapter || qi?.payload?.chapter || '全部章节';
            return (
              <span key={j.id} className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--fg-3)]">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] animate-pulse-soft" />
                <span className="truncate">
                  {chapter} · {qi ? (QUEUE_KIND_LABEL[qi.kind] || qi.kind || '渲染') + ' · 正在渲染 ' + queueSubject(qi) : (j.phase || '准备中')}
                </span>
              </span>
            );
          })}
          {liveWaiting.length ? <span className="text-[10.5px] text-[var(--fg-4)]">另有 {liveWaiting.length} 个渲染排队</span> : null}
        </div>
      ) : null}

      <ProgressPanel progress={progress} activeJob={runningJob} />

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex h-fit flex-col gap-3 lg:sticky lg:top-[86px]">
          <nav className="panel p-2">
            <p className="section-label px-2.5 pb-2 pt-2">Workspace</p>
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              const active = pview === t.key;
              const count = t.key === 'chapters' ? chapters.length : t.key === 'logs' ? finishedJobs.length : null;
              return (
                <button key={t.key} type="button" data-active={active} className="nav-item" onClick={() => setTab(t.key)}>
                  <Icon size={15} className={active ? 'text-[var(--accent)]' : 'text-[var(--fg-3)]'} />
                  <span className="flex-1 text-left">{t.label}</span>
                  {count != null && count > 0 ? <span className="font-mono text-[10.5px] text-[var(--fg-4)]">{count}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="panel flex flex-col gap-2.5 p-3.5">
            <div className="flex items-center justify-between">
              <span className="section-label">运行状态</span>
              <Activity size={13} className={runningJob ? 'text-[var(--accent)]' : 'text-[var(--fg-4)]'} />
            </div>
            {runningJob ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[var(--accent)]" />
                  <span className="truncate text-[12px] font-medium text-[var(--fg)]">{JOB_LABEL[runningJob.type] || runningJob.type}</span>
                </div>
                {runningJob.subjectLabel ? <p className="m-0 truncate text-[11px] text-[var(--fg-3)]">{runningJob.subjectLabel}</p> : null}
                {runningJob.phase ? <p className="m-0 line-clamp-2 text-[11px] leading-relaxed text-[var(--fg-4)]">{runningJob.phase}</p> : null}
                <ProgressPanel progress={progress} activeJob={runningJob} compact />
                {readOnly ? null : (
                  <Button variant="danger" size="sm" className="mt-0.5 w-full" onClick={stop}>
                    <Square size={12} /> 停止全部
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="m-0 text-[12px] text-[var(--fg-2)]">当前空闲</p>
                <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">生成按章节串行推进；在「章节管理」里选择一章开始。</p>
              </>
            )}
          </div>

          <div className="panel flex flex-col gap-2 p-3.5 text-[11px] text-[var(--fg-3)]">
            <div className="flex items-center justify-between">
              <span>背景音乐</span>
              <span className="text-[var(--fg-2)]">{project.enable_bgm ? '开启' : '关闭'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>自动字幕</span>
              <span className="text-[var(--fg-2)]">{project.enable_subtitles ? '开启' : '关闭'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>已结束任务</span>
              <span className="font-mono text-[var(--fg-2)]">{finishedJobs.length}</span>
            </div>
          </div>
        </aside>

        <section className="min-w-0">
          {pview === 'workflow' ? (
            <WorkflowPage
              projectId={id}
              features={features}
              chapters={chapters}
              progress={progress}
              running={running}
              readOnly={readOnly}
              canGenerate={canGenerate}
              onRefresh={() => {
                loadProject();
                refreshProgress();
              }}
              onGoLogs={() => setTab('logs')}
            />
          ) : null}
          {pview === 'chapters' ? (
            <ChaptersPage
              projectId={id}
              features={features}
              chapters={chapters}
              onRefresh={loadProject}
              running={running}
              runningChapter={runningChapter}
              runningChapters={runningChapters}
              readOnly={readOnly}
              canEdit={canEdit}
              canGenerate={canGenerate}
              onRun={run}
              onStop={stop}
              onGoLogs={() => setTab('logs')}
            />
          ) : null}
          {pview === 'assets' ? <AssetsPage projectId={id} jobs={jobsForSubject} onRefresh={loadProject} readOnly={readOnly} canEdit={canEdit} canGenerate={canGenerate} features={features} /> : null}
          {pview === 'shots' ? (
            <ShotsPage projectId={id} chapters={chapters} cursorId={cursorId} onCursorChange={setCursorId} running={running} jobs={jobsForSubject} onRefresh={loadProject} readOnly={readOnly} canEdit={canEdit} canGenerate={canGenerate} canExport={canExport} features={features} />
          ) : null}
          {pview === 'music' ? <MusicPage projectId={id} chapters={chapters} running={running} onRefresh={loadProject} readOnly={readOnly} canEdit={canEdit} canGenerate={canGenerate} features={features} /> : null}
          {pview === 'exports' ? <ExportsPage projectId={id} readOnly={readOnly} canExport={canExport} features={features} /> : null}
          {pview === 'logs' ? <LogsPage projectId={id} events={events} jobs={jobs} onRefresh={loadProject} readOnly={readOnly} /> : null}
        </section>
      </div>

      <TaskDrawer
        open={queueOpen}
        onOpenChange={setQueueOpen}
        jobs={jobs}
        progress={progress}
        queue={queue}
        runningCount={runningCount}
        queuedCount={queuedCount}
        finishedCount={finishedJobs.length}
        shownJobs={shownJobs}
        readOnly={readOnly}
        onStopAll={stop}
        onClearFinished={clearFinished}
        onCancel={cancelJob}
        onRemove={removeJob}
      />

      <ProjectSettingsDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        project={project}
        onSaved={loadProject}
      />
    </div>
  );
}
