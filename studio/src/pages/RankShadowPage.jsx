// 无限・秩影：lemo-opuscar 代码电影工作台。
// 交互：主页面只留风格库（卡片 + 分类筛选）；点「使用风格」弹创建表单弹窗；
// 顶部右上角「生成记录」按钮弹记录弹窗（搜索/状态筛选/编辑/重新生成/删除/批量删除）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Clapperboard, Eye, ExternalLink, History, Paperclip, Pencil, Play, Plus, RefreshCw, Send, Sparkles, Square, Terminal, Trash2, WandSparkles, X } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { Badge, Button, Checkbox, EmptyState, Field, Input, SearchInput, Select, Skeleton, Spinner, StatusPill, Textarea } from '../components/ui.jsx';
import { Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { FilePill, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { fileUrl, STATUS_TEXT, fmtTime, JOB_LABEL, JOB_STATUS_META } from '../lib/format.js';
import { useToast } from '../components/toast.jsx';

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '生成中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
];

const KIND_LABEL = { image: '图片', audio: '音频', video: '视频', file: '文件' };
const PREVIEW_KINDS = new Set(['image', 'audio', 'video']); // 仅有这三类素材显示缩略图，其它文件保持文字标签

// 素材缩略图：图片/视频直接显示画面，音频用波形图标；file 等其它类型不预览。
function MaterialTile({ kind, name, src, onRemove }) {
  const previewSrc = kind === 'video' && src ? src + '#t=0.1' : src; // 取首帧作为视频缩略图
  return (
    <div className="group relative w-20 overflow-hidden rounded-lg border border-[var(--line)] bg-black/40">
      <div className="relative h-20 w-full overflow-hidden bg-black/30">
        {kind === 'image' && src ? (
          <img src={src} alt={name || ''} loading="lazy" className="h-full w-full object-cover" />
        ) : null}
        {kind === 'video' && src ? (
          <video src={previewSrc} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : null}
        {kind === 'audio' ? (
          <div className="flex h-full w-full items-center justify-center text-[var(--accent)]">
            <AudioLines size={22} />
          </div>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            aria-label="移除素材"
            onClick={onRemove}
            className="absolute right-1 top-1 rounded-full bg-black/65 p-1 text-white transition-colors hover:bg-black/85"
          >
            <X size={11} />
          </button>
        ) : null}
        {kind === 'video' || kind === 'audio' ? (
          <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/65 px-1 py-0.5 text-[9px] leading-none text-white">
            {kind === 'video' ? <Play size={8} /> : <AudioLines size={8} />}
            {KIND_LABEL[kind]}
          </span>
        ) : null}
      </div>
      <div className="truncate px-1.5 py-1 text-[10.5px] text-[var(--fg-3)]" title={name || ''}>{name || '（未命名）'}</div>
    </div>
  );
}

const PAGE_SIZE = 24; // 风格库每页数量（懒加载分页）

export default function RankShadowPage() {
  const toast = useToast();
  const projectId = useAutoProject('opuscar', '无限・秩影');
  const { jobs, reloadJobs } = useJobs(projectId);

  // 风格库
  const [styles, setStyles] = useState([]);
  const [cat, setCat] = useState('全部');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef(null);

  // 创建弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [picked, setPicked] = useState(null); // 预设风格（选中卡片）
  const [styleMode, setStyleMode] = useState('preset'); // preset | custom
  const [customStyle, setCustomStyle] = useState(''); // 自定义风格描述
  const [prompt, setPrompt] = useState('');
  const [materials, setMaterials] = useState([]); // { type, filename, name }
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // 记录弹窗（Agent 聊天窗）：左侧任务列表，右侧输入摘要 + 对话 + Agent 执行日志
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [records, setRecords] = useState([]);
  const [kw, setKw] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState([]);
  const [activeRecordId, setActiveRecordId] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const [jobLogs, setJobLogs] = useState({}); // jobId -> 完整日志文本
  const chatScrollRef = useRef(null);

  // 样例预览弹窗（内置样例库来自 public/samples/，与项目 data 目录解耦）
  const [samples, setSamples] = useState([]);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [sampleId, setSampleId] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);

  // 运行日志弹窗
  const [logsOpen, setLogsOpen] = useState(false);
  const [logJobId, setLogJobId] = useState('');
  const [fullLog, setFullLog] = useState(null);
  const [logTick, setLogTick] = useState(0);
  const logRef = useRef(null);

  // 编辑弹窗（记录弹窗之上）
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editStyleMode, setEditStyleMode] = useState('preset');
  const [editStyle, setEditStyle] = useState('');
  const [editCustomStyle, setEditCustomStyle] = useState('');
  const [editMaterials, setEditMaterials] = useState([]);
  const [editBusy, setEditBusy] = useState(false);
  const editFileRef = useRef(null);

  useEffect(() => {
    api.get('/api/opuscar/styles').then((list) => setStyles(Array.isArray(list) ? list : [])).catch(() => setStyles([]));
    api.get('/api/opuscar/samples').then((list) => setSamples(Array.isArray(list) ? list : [])).catch(() => setSamples([]));
  }, []);

  const loadRecords = useMemo(
    () => () => {
      if (!projectId) return;
      api.get('/api/projects/' + projectId + '/opuscar').then((list) => setRecords(Array.isArray(list) ? list : [])).catch(() => setRecords([]));
    },
    [projectId],
  );

  useEffect(() => {
    loadRecords();
    const t = setInterval(loadRecords, 4000);
    return () => clearInterval(t);
  }, [loadRecords]);

  const activeSample = useMemo(
    () => samples.find((r) => r.id === sampleId) || samples[0] || null,
    [samples, sampleId],
  );

  // 一键试用：把样例的风格/提示词填入创建弹窗，并把样例素材上传到当前项目目录
  async function trySample(s) {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    const st = s.style || {};
    if (st.slug === '__custom__') {
      setStyleMode('custom');
      setPicked(null);
      setCustomStyle(st.custom_style || '');
    } else {
      setStyleMode('preset');
      setPicked(styles.find((x) => x.slug === st.slug) || { slug: st.slug, cn: st.cn || st.slug, cat: st.cat || '' });
    }
    setPrompt(s.prompt || '');
    setSampleBusy(true);
    try {
      const added = [];
      for (const m of s.materials || []) {
        const res = await fetch(m.url);
        if (!res.ok) throw new Error('样例素材下载失败：' + (m.name || m.url));
        const blob = await res.blob();
        added.push(await uploadOne(new File([blob], m.name || 'sample', { type: blob.type || 'application/octet-stream' })));
      }
      setMaterials(added);
      setSamplesOpen(false);
      setCreateOpen(true);
      toast.success('已导入样例素材，并上传到当前项目');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSampleBusy(false);
    }
  }

  // 运行日志：自动选中当前/最近一条 opuscar 任务，弹窗打开期间定时拉取完整日志
  const opuscarJobs = useMemo(() => (jobs || []).filter((j) => j.type === 'opuscar'), [jobs]);
  const activeLogJob = useMemo(
    () => opuscarJobs.find((j) => j.status === 'running' || j.status === 'queued') || opuscarJobs[0] || null,
    [opuscarJobs],
  );
  const logJob = (logJobId && opuscarJobs.find((j) => j.id === logJobId)) || activeLogJob;
  const logJobId2 = logJob ? logJob.id : '';
  const logLive = !!(logJob && (logJob.status === 'running' || logJob.status === 'queued'));

  useEffect(() => {
    if (!logsOpen || !logJobId2) {
      setFullLog(null);
      return undefined;
    }
    const load = () =>
      api.get('/api/projects/' + projectId + '/jobs/' + logJobId2 + '/log')
        .then((r) => setFullLog(r))
        .catch(() => setFullLog(null));
    load();
    if (!logLive) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [logsOpen, projectId, logJobId2, logLive, logTick]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [fullLog]);

  const categories = useMemo(() => ['全部', ...Array.from(new Set(styles.map((s) => s.cat).filter(Boolean)))], [styles]);
  const shownStyles = useMemo(() => (cat === '全部' ? styles : styles.filter((s) => s.cat === cat)), [styles, cat]);
  // 分页懒加载：只渲染前 visibleCount 张卡片
  const visibleStyles = useMemo(() => shownStyles.slice(0, visibleCount), [shownStyles, visibleCount]);
  const hasMore = visibleCount < shownStyles.length;

  // 切换分类时重置分页
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [cat]);

  // 滚动到网格底部哨兵时自动加载下一页
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, shownStyles.length));
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, shownStyles.length]);

  const filtered = useMemo(() => records.filter((r) => {
    if (status !== 'all') {
      const s = r.status;
      if (status === 'running' && !(s === 'generating' || s === 'running' || s === 'pending')) return false;
      if (status === 'done' && s !== 'done') return false;
      if (status === 'failed' && s !== 'failed') return false;
    }
    const k = kw.trim().toLowerCase();
    if (!k) return true;
    const p = r.params || {};
    return String(r.name || '').toLowerCase().includes(k)
      || String(r.prompt || '').toLowerCase().includes(k)
      || String(p.style_cn || '').toLowerCase().includes(k);
  }), [records, kw, status]);

  const runningIds = useMemo(() => new Set((jobs || []).filter((j) => j.type === 'opuscar' && (j.status === 'running' || j.status === 'queued') && j.checkpoint && j.checkpoint.subject).map((j) => j.checkpoint.subject)), [jobs]);
  // 记录 -> 正在执行的 opuscar 任务，供「停止」按钮使用
  const runningJobByAsset = useMemo(() => {
    const m = new Map();
    for (const j of jobs || []) {
      if (j.type !== 'opuscar' || j.status !== 'running' && j.status !== 'queued') continue;
      const subject = j.checkpoint && j.checkpoint.subject;
      if (subject) m.set(subject, j.id);
    }
    return m;
  }, [jobs]);

  // ── 聊天窗：当前记录 / 对话历史 / 每轮对应的任务与日志 ──
  const activeRecord = useMemo(() => records.find((r) => r.id === activeRecordId) || null, [records, activeRecordId]);

  // 打开弹窗或当前记录被删除后，自动选中列表第一条
  useEffect(() => {
    if (!recordsOpen || activeRecord || !records.length) return;
    setActiveRecordId(records[0].id);
  }, [recordsOpen, activeRecord, records]);

  // 当前记录的对话历史（params.chat，越靠后越新）
  const chatMessages = useMemo(
    () => (Array.isArray(activeRecord && activeRecord.params && activeRecord.params.chat) ? activeRecord.params.chat : []),
    [activeRecord],
  );

  // 兼容旧记录（没有写入 chat）：用初始提示词兜底成第一条用户消息
  const chatTurns = useMemo(() => {
    if (chatMessages.length) return chatMessages;
    if (!activeRecord) return [];
    return [{ role: 'user', text: activeRecord.prompt || '（无提示词）', at: activeRecord.created_at }];
  }, [chatMessages, activeRecord]);

  // 当前记录的输入摘要（风格 / 提示词 / 素材）与成片地址
  const activeParams = (activeRecord && activeRecord.params) || {};
  const activeRefs = Array.isArray(activeParams.references) ? activeParams.references : [];
  const activeVideoUrl = activeRecord && activeRecord.video_path ? fileUrl(projectId, activeRecord.video_path) : '';

  // 当前记录的全部 opuscar 任务（jobs 已按 started_at 倒序，第一个即最近一次）
  const recordJobs = useMemo(
    () => (jobs || []).filter((j) => j.type === 'opuscar' && (j.checkpoint || {}).subject === (activeRecord ? activeRecord.id : '')),
    [jobs, activeRecord],
  );

  // 对话轮次 -> 任务：checkpoint.turn 指向 params.chat 的下标；同一轮多次重试只取最新一次
  const jobByTurn = useMemo(() => {
    const m = new Map();
    for (const j of recordJobs) {
      const turn = Number((j.checkpoint || {}).turn);
      const key = Number.isFinite(turn) ? turn : 0;
      if (!m.has(key)) m.set(key, j);
    }
    return m;
  }, [recordJobs]);

  const recordRunning = !!(activeRecord && runningIds.has(activeRecord.id));

  // 拉取当前记录每一次任务的完整日志；有运行中的任务时每 4s 刷新
  const recordJobsKey = recordJobs.map((j) => j.id + ':' + j.status).join('|');
  useEffect(() => {
    if (!recordsOpen || !projectId || !recordJobs.length) {
      setJobLogs({});
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      Promise.all(
        recordJobs.map((j) =>
          api.get('/api/projects/' + projectId + '/jobs/' + j.id + '/log')
            .then((r) => [j.id, (r && r.text) || ''])
            .catch(() => [j.id, '']),
        ),
      ).then((pairs) => {
        if (!cancelled) setJobLogs(Object.fromEntries(pairs));
      });
    };
    load();
    const live = recordJobs.some((j) => j.status === 'running' || j.status === 'queued');
    if (!live) return () => { cancelled = true; };
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [recordsOpen, projectId, activeRecordId, recordJobsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 新消息 / 日志更新时把聊天区滚到底部
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [recordsOpen, activeRecordId, chatMessages.length, jobLogs]);

  // 点「使用风格」→ 打开创建弹窗并预填预设风格
  function pickStyle(s) {
    setPicked(s);
    setStyleMode('preset');
    setCreateOpen(true);
  }

  // 点「自定义风格」→ 打开创建弹窗，切到自定义风格输入
  function pickCustom() {
    setStyleMode('custom');
    setPicked(null);
    setCreateOpen(true);
  }

  async function uploadOne(file) {
    const fd = new FormData();
    fd.append('file', file);
    const j = await uploadForm('/api/projects/' + projectId + '/media', fd);
    const type = ['image', 'audio', 'video', 'file'].includes(j.kind) ? j.kind : 'file';
    return { type, filename: j.path, name: file.name };
  }

  async function onFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    try {
      const added = [];
      for (const f of files) added.push(await uploadOne(f));
      setMaterials((prev) => [...prev, ...added]);
    } catch (err) {
      toast.error(err.message);
    }
  }

  // 一键清空表单：清掉已填写的自定义风格、素材与提示词，保留已选风格方便重新填写
  function clearForm() {
    setCustomStyle('');
    setMaterials([]);
    setPrompt('');
  }

  async function create() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (styleMode === 'preset' && !picked) {
      toast.error('请选择风格');
      return;
    }
    if (styleMode === 'custom' && !customStyle.trim()) {
      toast.error('请填写自定义风格描述');
      return;
    }
    if (!prompt.trim()) {
      toast.error('请输入提示词');
      return;
    }
    setBusy(true);
    try {
      const body = {
        style_slug: styleMode === 'preset' ? picked.slug : '__custom__',
        prompt: prompt.trim(),
        references: materials,
      };
      if (styleMode === 'custom') body.custom_style = customStyle.trim();
      const job = await api.post('/api/projects/' + projectId + '/opuscar', body);
      toast.success('已创建生成任务');
      setPrompt('');
      setMaterials([]);
      setCreateOpen(false);
      // 提交后直接进入该记录的 Agent 聊天窗，观察执行过程并在完成后继续修改
      const aid = job && job.checkpoint && job.checkpoint.subject;
      if (aid) setActiveRecordId(aid);
      setRecordsOpen(true);
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(r) {
    if (!projectId) return;
    const p = r.params || {};
    setBusy(true);
    try {
      const body = {
        asset_id: r.id,
        style_slug: p.style_slug,
        prompt: r.prompt || '',
        references: p.references || [],
      };
      if (p.style_slug === '__custom__') body.custom_style = p.custom_style || '';
      const job = await api.post('/api/projects/' + projectId + '/opuscar', body);
      toast.success('已重新生成');
      const aid = job && job.checkpoint && job.checkpoint.subject;
      if (aid) setActiveRecordId(aid);
      setRecordsOpen(true);
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stopOne(r) {
    if (!projectId) return;
    const jid = runningJobByAsset.get(r.id);
    if (!jid) {
      toast.error('没有可停止的任务');
      return;
    }
    if (!(await toast.confirm('停止「' + (r.name || '未命名') + '」的生成？已渲染的部分不会保存为成片。', { confirmLabel: '停止生成' }))) return;
    try {
      await api.post('/api/projects/' + projectId + '/jobs/' + jid + '/cancel');
      toast.success('已停止生成');
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    }
  }

  // 聊天底部继续输入：在已有记录上追加一条修改要求，Agent 会在上一版成片上继续改
  async function sendContinue() {
    if (!projectId || !activeRecord) return;
    const msg = chatInput.trim();
    if (!msg) return;
    if (recordRunning) {
      toast.error('该记录正在生成中，请等它结束或先停止');
      return;
    }
    setSending(true);
    try {
      await api.post('/api/projects/' + projectId + '/opuscar', { asset_id: activeRecord.id, message: msg });
      setChatInput('');
      toast.success('已提交修改要求');
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  }

  async function removeOne(r) {
    if (!projectId) return;
    if (!(await toast.confirm('删除记录「' + (r.name || '未命名') + '」？删除后不可恢复。', { danger: true, confirmLabel: '删除' }))) return;
    try {
      await api.del('/api/projects/' + projectId + '/opuscar/' + r.id);
      toast.success('已删除');
      setSelected((prev) => prev.filter((id) => id !== r.id));
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const selectableIds = filtered.filter((r) => !runningIds.has(r.id)).map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));

  function toggleAll() {
    setSelected(allSelected ? [] : selectableIds);
  }
  function toggleOne(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function batchDelete() {
    if (!projectId || !selected.length) return;
    if (!(await toast.confirm('删除选中的 ' + selected.length + ' 条记录？', { danger: true, confirmLabel: '批量删除' }))) return;
    try {
      const r = await api.post('/api/projects/' + projectId + '/opuscar/batch-delete', { ids: selected });
      const done = (r.deleted || []).length;
      const skipped = (r.skipped || []).length;
      toast.success('已删除 ' + done + ' 条' + (skipped ? '，跳过 ' + skipped + ' 条' : ''));
      setSelected([]);
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    }
  }

  function openEdit(r) {
    const p = r.params || {};
    setEditing(r);
    setEditName(r.name || '');
    setEditPrompt(r.prompt || '');
    const isCustom = p.style_slug === '__custom__';
    setEditStyleMode(isCustom ? 'custom' : 'preset');
    setEditStyle(isCustom ? '' : (p.style_slug || ''));
    setEditCustomStyle(isCustom ? (p.custom_style || '') : '');
    setEditMaterials(p.references || []);
  }

  async function onEditFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    try {
      const added = [];
      for (const f of files) added.push(await uploadOne(f));
      setEditMaterials((prev) => [...prev, ...added]);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function saveEdit() {
    if (!projectId || !editing) return;
    if (editStyleMode === 'preset' && !editStyle) {
      toast.error('请选择风格');
      return;
    }
    if (editStyleMode === 'custom' && !editCustomStyle.trim()) {
      toast.error('请填写自定义风格描述');
      return;
    }
    setEditBusy(true);
    try {
      const body = {
        name: editName,
        prompt: editPrompt,
        style_slug: editStyleMode === 'preset' ? editStyle : '__custom__',
        references: editMaterials,
      };
      if (editStyleMode === 'custom') body.custom_style = editCustomStyle.trim();
      await api.patch('/api/projects/' + projectId + '/opuscar/' + editing.id, body);
      toast.success('已保存');
      setEditing(null);
      loadRecords();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Infinite·Rank Shadow"
        title="无限・秩影"
        badge="beta"
        description="支持创作宣导片、热门音乐 MV、知识讲解类视频等多种内容。上传参考素材并配置提示词后，由 Agent 自动完成素材剪辑与渲染，直接输出对应风格成片。"
        actions={
          <>
            <Button variant="secondary" size="md" onClick={pickCustom}>
              <Sparkles size={14} /> 自定义风格
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => window.open('https://lemomo-ai.github.io/lemo-opuscar/opuscar98/#styles', '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink size={14} /> 更多风格
            </Button>
            <Button variant="secondary" size="md" onClick={() => setRecordsOpen(true)}>
              <History size={14} /> 生成记录（{records.length}）
            </Button>
            <Button variant="secondary" size="md" onClick={() => { setSamplesOpen(true); setSampleId(''); }}>
              <Eye size={14} /> 预览样例{samples.length ? `（${samples.length}）` : ''}
            </Button>
            <Button variant="secondary" size="md" onClick={() => { setLogsOpen(true); setLogTick((t) => t + 1); }}>
              <Terminal size={14} /> 运行日志
            </Button>
          </>
        }
      />

      {/* ===== 风格库 ===== */}
      <section className="panel flex flex-col gap-4 p-4">
        <div className="toolbar">
          <h2 className="m-0 text-[13px] font-semibold text-[var(--fg-2)]">风格库</h2>
          <span className="text-[11px] text-[var(--fg-4)]">{styles.length} 个风格</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={
                'h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors ' +
                (cat === c
                  ? 'border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                  : 'border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)] hover:text-[var(--fg-2)]')
              }
            >
              {c}
            </button>
          ))}
        </div>

        {!styles.length ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col overflow-hidden rounded-xl border border-[var(--line)]">
                <Skeleton className="aspect-[4/3] rounded-none" />
                <div className="flex flex-col gap-2 p-2.5">
                  <Skeleton className="h-3.5 w-4/5" />
                  <Skeleton className="h-2.5 w-3/5" />
                  <Skeleton className="mt-1 h-7 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {visibleStyles.map((s) => (
              <article
                key={s.slug}
                className="flex flex-col overflow-hidden rounded-xl border border-[var(--line)] transition-colors hover:border-[var(--line-strong)]"
              >
                <div className="aspect-[4/3] overflow-hidden bg-black/40">
                  <img
                    src={'/api/opuscar/style-image?slug=' + s.slug}
                    alt={s.cn || s.slug}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2.5">
                  <span className="truncate text-[12.5px] font-medium text-[var(--fg)]" title={s.cn}>{s.cn || s.slug}</span>
                  <span className="truncate text-[10.5px] text-[var(--fg-4)]">{s.en} · {s.cat}</span>
                  <div className="mt-auto pt-1.5">
                    <Button variant="secondary" size="xs" className="w-full" onClick={() => pickStyle(s)}>
                      <Plus size={12} /> 使用风格
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {/* 懒加载哨兵：滚动到底部自动加载下一页 */}
        {hasMore ? (
          <div ref={sentinelRef} className="flex items-center justify-center gap-2 py-2 text-[11.5px] text-[var(--fg-4)]">
            <Sparkles size={13} className="animate-pulse" /> 已显示 {visibleStyles.length} / {shownStyles.length}，滚动加载更多…
          </div>
        ) : (
          <div className="text-center text-[11px] text-[var(--fg-4)]">已全部加载 {shownStyles.length} 个风格</div>
        )}
      </section>

      {/* ===== 创建弹窗 ===== */}
      <Modal
        open={createOpen}
        onOpenChange={(v) => { if (!v) setCreateOpen(false); }}
        title="创建生成"
        description={styleMode === 'preset' && picked ? (picked.cn || picked.slug) + ' · ' + picked.cat : '自定义风格'}
        size="lg"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              className="mr-auto"
              disabled={busy || (!materials.length && !prompt && !customStyle)}
              onClick={clearForm}
            >
              <Trash2 size={13} /> 清空表单
            </Button>
            <Button variant="secondary" size="md" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={create}>
              <Clapperboard size={14} /> 创建生成任务
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setStyleMode('preset')}
              className={
                'h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors ' +
                (styleMode === 'preset'
                  ? 'border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                  : 'border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)] hover:text-[var(--fg-2)]')
              }
            >
              预设风格
            </button>
            <button
              type="button"
              onClick={() => setStyleMode('custom')}
              className={
                'h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors ' +
                (styleMode === 'custom'
                  ? 'border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                  : 'border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)] hover:text-[var(--fg-2)]')
              }
            >
              自定义风格
            </button>
          </div>

          {styleMode === 'preset' ? (
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] text-[var(--fg-3)]">已选风格</span>
              {picked ? (
                <Badge tone="accent">{picked.cn || picked.slug} · {picked.cat}</Badge>
              ) : (
                <span className="text-[12px] text-[var(--fg-4)]">未选择（请关闭弹窗，在风格库点击「使用风格」）</span>
              )}
            </div>
          ) : (
            <Field label="自定义风格描述" required hint="描述你想要的目标风格（画风 / 配色 / 镜头语言 / 节奏 / 材质等），Agent 会据此结合素材渲染成片。">
              <Textarea rows={4} value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} placeholder="例如：复古手绘水彩质感，暖色调，缓慢推进的镜头，配合怀旧胶片颗粒…" />
            </Field>
          )}

          <Field label="素材" hint="可上传任意文件（图片 / 音频 / 视频 / 数据 / 扫描 / CAD / 字体 / 文档等），Agent 会读取并使用这些素材结合所选风格渲染成片。">
            <div className="flex flex-col gap-2">
              <div>
                <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                  <Paperclip size={13} /> 添加素材（{materials.length}）
                </Button>
                <input ref={fileRef} type="file" multiple className="hidden" onChange={onFiles} />
              </div>
              {materials.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {materials.map((m, i) =>
                    PREVIEW_KINDS.has(m.type) ? (
                      <MaterialTile
                        key={i}
                        kind={m.type}
                        name={m.name}
                        src={projectId && m.filename ? fileUrl(projectId, m.filename) : ''}
                        onRemove={() => setMaterials((prev) => prev.filter((_, idx) => idx !== i))}
                      />
                    ) : (
                      <FilePill key={i} onRemove={() => setMaterials((prev) => prev.filter((_, idx) => idx !== i))}>
                        [{KIND_LABEL[m.type] || '文件'}] {m.name}
                      </FilePill>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          </Field>

          <Field label="提示词" required>
            <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想创作的短片主题、内容与风格方向…" />
          </Field>
        </div>
      </Modal>

      {/* ===== 生成记录 · Agent 聊天窗 ===== */}
      <Modal
        open={recordsOpen}
        onOpenChange={(v) => { if (!v) setRecordsOpen(false); }}
        title="生成记录 · Agent 聊天窗"
        description="左侧选择任务，右侧查看用户输入摘要、对话与 Agent 执行日志；成片产出后可在底部继续提出修改要求。"
        size="5xl"
        className="h-[88vh]"
        footer={
          <Button variant="secondary" size="md" onClick={() => setRecordsOpen(false)}>关闭</Button>
        }
      >
        <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
          {/* 左：任务列表（标题 + 摘要 + 状态） */}
          <aside className="flex max-h-[38%] shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-white/[0.02] md:max-h-none md:w-[272px]">
            <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--line)] p-2.5">
              <SearchInput value={kw} onChange={setKw} placeholder="搜索名称 / 提示词 / 风格" />
              <div className="flex items-center gap-1.5">
                <Select value={status} onChange={setStatus} items={STATUS_OPTIONS} size="sm" className="min-w-0 flex-1" />
                <Button variant="danger" size="xs" disabled={!selected.length} onClick={batchDelete}>
                  <Trash2 size={11} /> 删除（{selected.length}）
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox checked={allSelected} onChange={toggleAll} label="全选" />
                <span className="truncate text-[10.5px] text-[var(--fg-4)]">生成中的记录自动跳过批量删除</span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!filtered.length ? (
                <EmptyState
                  icon={Clapperboard}
                  title="暂无记录"
                  description="选一个风格、上传素材并写下提示词，生成的成片会出现在这里。"
                  className="py-8"
                />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {filtered.map((r) => {
                    const running = runningIds.has(r.id);
                    const url = r.video_path ? fileUrl(projectId, r.video_path) : '';
                    const active = r.id === activeRecordId;
                    return (
                      <article
                        key={r.id}
                        onClick={() => setActiveRecordId(r.id)}
                        className={
                          'flex cursor-pointer items-center gap-2 rounded-lg border p-2 transition-colors ' +
                          (active
                            ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                            : 'border-transparent hover:border-[var(--line)] hover:bg-white/[0.03]')
                        }
                      >
                        <Checkbox checked={selected.includes(r.id)} onChange={() => toggleOne(r.id)} disabled={running} />
                        <div className="h-12 w-[68px] shrink-0 overflow-hidden rounded-md bg-black/40">
                          {url ? (
                            <video src={url + '#t=0.1'} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] text-[var(--fg-4)]">
                              {running ? '生成中' : '无成片'}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-medium text-[var(--fg)]" title={r.name}>{r.name || '（未命名）'}</span>
                            {running ? <Spinner size={11} /> : null}
                          </div>
                          <div className="line-clamp-2 text-[10.5px] leading-snug text-[var(--fg-4)]" title={r.prompt}>{r.prompt || '（无提示词）'}</div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <StatusPill status={r.status}>{STATUS_TEXT[r.status] || r.status || '排队中'}</StatusPill>
                            <span className="truncate text-[10px] text-[var(--fg-4)]">{fmtTime(r.created_at)}</span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          {/* 右：用户输入摘要 + 对话 + Agent 日志 + 底部继续输入 */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-black/10">
            {!activeRecord ? (
              <EmptyState
                icon={Clapperboard}
                title="选择一条记录"
                description="从左侧选择一条生成记录，查看它的输入内容、Agent 执行日志，并在底部继续提出修改。"
              />
            ) : (
              <>
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] bg-white/[0.02] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-[var(--fg)]" title={activeRecord.name}>{activeRecord.name || '（未命名）'}</span>
                      <StatusPill status={activeRecord.status}>{STATUS_TEXT[activeRecord.status] || activeRecord.status || '排队中'}</StatusPill>
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-[var(--fg-4)]">
                      风格：{activeParams.style_cn || activeParams.style_slug || '—'}{activeParams.cat ? ' · ' + activeParams.cat : ''} · 对话 {chatTurns.length} 轮 · {fmtTime(activeRecord.created_at)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {activeVideoUrl ? (
                      <a
                        href={activeVideoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-7 items-center rounded-lg border border-[var(--line)] bg-white/[0.04] px-2.5 text-[12px] font-medium text-[var(--fg)] transition-colors hover:border-[var(--line-strong)] hover:bg-white/[0.07]"
                      >
                        预览 / 下载
                      </a>
                    ) : null}
                    {recordRunning ? (
                      <Button variant="secondary" size="xs" onClick={() => stopOne(activeRecord)}>
                        <Square size={11} /> 停止
                      </Button>
                    ) : null}
                    <Button variant="secondary" size="xs" disabled={recordRunning} onClick={() => openEdit(activeRecord)}>
                      <Pencil size={11} /> 编辑
                    </Button>
                    <Button variant="secondary" size="xs" disabled={recordRunning || busy} onClick={() => regenerate(activeRecord)}>
                      <RefreshCw size={11} /> 重新生成
                    </Button>
                    <Button variant="ghost" size="xs" className="text-[var(--fg-3)] hover:text-[var(--danger)]" disabled={recordRunning} onClick={() => removeOne(activeRecord)}>
                      <Trash2 size={11} />
                    </Button>
                  </div>
                </header>

                <div ref={chatScrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
                  {/* 用户输入摘要：风格 / 提示词 / 素材 */}
                  <div className="rounded-xl border border-[var(--line)] bg-white/[0.03] p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium text-[var(--fg-3)]">用户输入</span>
                      <Badge tone="accent">{activeParams.style_slug === '__custom__' ? '自定义风格' : (activeParams.style_cn || activeParams.style_slug || '—')}</Badge>
                      {activeParams.cat && activeParams.style_slug !== '__custom__' ? <Badge tone="neutral">{activeParams.cat}</Badge> : null}
                      <span className="text-[10.5px] text-[var(--fg-4)]">素材 {activeRefs.length}</span>
                    </div>
                    {activeParams.style_slug === '__custom__' && activeParams.custom_style ? (
                      <div className="logbox mb-2 max-h-[120px] text-[11.5px]">{activeParams.custom_style}</div>
                    ) : null}
                    <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--fg-2)]">{activeRecord.prompt || '（无提示词）'}</div>
                    {activeRefs.length ? (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {activeRefs.map((m, i) =>
                          PREVIEW_KINDS.has(m.type) && projectId && m.filename ? (
                            <MaterialTile key={i} kind={m.type} name={m.name || m.filename} src={fileUrl(projectId, m.filename)} />
                          ) : (
                            <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--line)] bg-white/[0.03] px-2.5 text-[11.5px] text-[var(--fg-2)]">
                              <span className="truncate">[{KIND_LABEL[m.type] || '文件'}] {m.name || m.filename}</span>
                            </span>
                          ),
                        )}
                      </div>
                    ) : null}
                  </div>

                  {/* 对话：每条用户消息 + 该轮 Agent 执行日志 */}
                  {chatTurns.map((m, i) => {
                    const job = jobByTurn.get(i);
                    // 本轮成片：优先用该轮写回的 video_path（每次修改各自一份）；
                    // 旧记录没有按轮记录时，最后一轮回退到记录当前成片。
                    const turnVideo = m.video_path
                      ? fileUrl(projectId, m.video_path)
                      : (i === chatTurns.length - 1 && !m.status ? activeVideoUrl : '');
                    return (
                      <div key={i} className="flex flex-col gap-2">
                        <div className="flex justify-end">
                          <div className="max-w-[88%] rounded-2xl rounded-br-sm border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] px-3 py-2">
                            <div className="mb-0.5 text-[10px] font-medium tracking-wide text-[var(--accent)]">
                              {i === 0 ? '初始需求' : '修改要求 ' + (i + 1)}
                            </div>
                            <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--fg)]">{m.text}</div>
                            {m.at ? <div className="mt-1 text-right text-[10px] text-[var(--fg-4)]">{fmtTime(m.at)}</div> : null}
                          </div>
                        </div>

                        <div className="flex justify-start">
                          <div className="w-full max-w-[94%] rounded-2xl rounded-bl-sm border border-[var(--line)] bg-white/[0.03] px-3 py-2">
                            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                              <span className="text-[11] font-medium text-[var(--fg-2)]">Agent</span>
                              {job ? (
                                <>
                                  <StatusPill status={job.status}>{JOB_STATUS_META[job.status]?.label || job.status}</StatusPill>
                                  {job.phase ? <span className="truncate text-[10.5px] text-[var(--fg-4)]">{job.phase}</span> : null}
                                </>
                              ) : (
                                <Badge tone="neutral">未执行</Badge>
                              )}
                            </div>
                            {job ? (
                              <pre className="logbox max-h-[220px] text-[11px]">{jobLogs[job.id] || (job.status === 'running' || job.status === 'queued' ? '（正在执行，日志加载中…）' : '（暂无日志）')}</pre>
                            ) : (
                              <span className="text-[11px] text-[var(--fg-4)]">本轮还没有执行任务。</span>
                            )}
                            {job && job.detail ? <p className="m-0 mt-1.5 line-clamp-2 text-[10.5px] leading-relaxed text-[var(--fg-4)]">{job.detail}</p> : null}
                            {job && job.error ? <p className="m-0 mt-1.5 break-words text-[10.5px] leading-relaxed text-[var(--danger)]">{job.error}</p> : null}
                          </div>
                        </div>

                        {/* 成片单独一个气泡，排在执行日志之后 */}
                        {turnVideo ? (
                          <div className="flex justify-start">
                            <div className="w-full max-w-[94%] rounded-2xl rounded-bl-sm border border-[var(--line)] bg-white/[0.03] px-3 py-2">
                              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                                <span className="text-[11px] font-medium text-[var(--fg-2)]">Agent · 成片输出</span>
                                {m.status ? <StatusPill status={m.status}>{STATUS_TEXT[m.status] || m.status}</StatusPill> : null}
                                {m.finished_at ? <span className="text-[10.5px] text-[var(--fg-4)]">{fmtTime(m.finished_at)}</span> : null}
                              </div>
                              <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-black/50">
                                <video src={turnVideo} controls playsInline preload="metadata" className="block max-h-[320px] w-full bg-black object-contain" />
                              </div>
                              <div className="mt-1.5 flex justify-end">
                                <a href={turnVideo} target="_blank" rel="noreferrer" className="text-[11px] text-[var(--accent)] no-underline hover:underline">
                                  预览 / 下载
                                </a>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {/* 底部继续输入：追加修改要求，Agent 在上一版成片上继续改 */}
                <footer className="shrink-0 border-t border-[var(--line)] bg-black/20 p-3">
                  <div className="flex items-end gap-2">
                    <Textarea
                      rows={2}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (!recordRunning && !sending && chatInput.trim()) sendContinue();
                        }
                      }}
                      disabled={recordRunning || sending}
                      placeholder={recordRunning ? 'Agent 正在执行，完成后可继续提出修改…' : '继续描述需要修改的地方，例如：把结尾改成分镜快切，背景音乐换成更舒缓的…'}
                      className="min-h-[60px] flex-1"
                      style={{ resize: 'none' }}
                    />
                    <Button variant="primary" size="md" loading={sending} disabled={sending || recordRunning || !chatInput.trim()} onClick={sendContinue}>
                      <Send size={14} /> 发送
                    </Button>
                  </div>
                  <div className="mt-1.5 text-[10.5px] text-[var(--fg-4)]">
                    Enter 发送 · Shift + Enter 换行{recordRunning ? ' · 生成中暂不可发送，可先停止生成' : ''}
                  </div>
                </footer>
              </>
            )}
          </section>
        </div>
      </Modal>

      {/* ===== 编辑弹窗 ===== */}
      <Modal
        open={!!editing}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
        title="编辑记录"
        description={editing ? editing.name : ''}
        size="lg"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" size="md" loading={editBusy} disabled={editBusy} onClick={saveEdit}>保存</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="名称">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
          </Field>
          <Field label="风格">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditStyleMode('preset')}
                  className={
                    'h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors ' +
                    (editStyleMode === 'preset'
                      ? 'border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                      : 'border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)] hover:text-[var(--fg-2)]')
                  }
                >
                  预设风格
                </button>
                <button
                  type="button"
                  onClick={() => setEditStyleMode('custom')}
                  className={
                    'h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors ' +
                    (editStyleMode === 'custom'
                      ? 'border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                      : 'border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)] hover:text-[var(--fg-2)]')
                  }
                >
                  自定义风格
                </button>
              </div>
              {editStyleMode === 'preset' ? (
                <Select
                  value={editStyle}
                  onChange={setEditStyle}
                  items={styles.map((s) => ({ value: s.slug, label: (s.cn || s.slug) + '（' + s.cat + '）' }))}
                />
              ) : (
                <Textarea rows={4} value={editCustomStyle} onChange={(e) => setEditCustomStyle(e.target.value)} placeholder="描述自定义风格…" />
              )}
            </div>
          </Field>
          <Field label="提示词">
            <Textarea rows={4} value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
          </Field>
          <Field label="素材">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {editMaterials.map((m, i) =>
                  PREVIEW_KINDS.has(m.type) ? (
                    <MaterialTile
                      key={i}
                      kind={m.type}
                      name={m.name || m.filename}
                      src={projectId && m.filename ? fileUrl(projectId, m.filename) : ''}
                      onRemove={() => setEditMaterials((prev) => prev.filter((_, idx) => idx !== i))}
                    />
                  ) : (
                    <FilePill key={i} onRemove={() => setEditMaterials((prev) => prev.filter((_, idx) => idx !== i))}>
                      [{KIND_LABEL[m.type] || '文件'}] {m.name || m.filename}
                    </FilePill>
                  ),
                )}
                {!editMaterials.length ? <span className="text-[11px] text-[var(--fg-4)]">暂无素材</span> : null}
              </div>
              <div>
                <Button variant="secondary" size="sm" onClick={() => editFileRef.current?.click()}>
                  <Plus size={13} /> 添加素材
                </Button>
                <input ref={editFileRef} type="file" multiple className="hidden" onChange={onEditFiles} />
              </div>
            </div>
          </Field>
        </div>
      </Modal>

      {/* ===== 运行日志弹窗 ===== */}
      <Modal
        open={logsOpen}
        onOpenChange={(v) => { if (!v) setLogsOpen(false); }}
        title="Agent 运行日志"
        description="实时进度来自任务状态；完整日志包含 Agent 每一步工具调用、技能加载与模型输出。"
        size="5xl"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setLogTick((t) => t + 1)}>
              <RefreshCw size={13} /> 刷新
            </Button>
            <Button variant="secondary" size="md" onClick={() => setLogsOpen(false)}>关闭</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {opuscarJobs.length ? (
              <div className="w-[320px] max-w-full">
                <Select
                  value={logJobId2}
                  onChange={setLogJobId}
                  size="sm"
                  items={[
                    { value: '', label: '自动：当前 / 最近任务' },
                    ...opuscarJobs.map((j) => ({
                      value: j.id,
                      label: (JOB_LABEL[j.type] || j.type) + ' · ' + (JOB_STATUS_META[j.status]?.label || j.status),
                    })),
                  ]}
                />
              </div>
            ) : null}
            {logJob ? (
              <StatusPill status={logJob.status}>{JOB_STATUS_META[logJob.status]?.label || logJob.status}</StatusPill>
            ) : (
              <Badge tone="neutral">暂无任务</Badge>
            )}
          </div>

          {!logJob ? (
            <EmptyState icon={Terminal} title="暂无运行日志" description="创建一次生成任务后，Agent 的每一步执行日志会出现在这里。" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[var(--fg-4)]">
                <span>{JOB_LABEL[logJob.type] || logJob.type}</span>
                {logJob.phase ? <span>· {logJob.phase}</span> : null}
                {logJob.detail ? <span>· {logJob.detail}</span> : null}
                {logJob.error ? <span className="text-[var(--danger)]">· {logJob.error}</span> : null}
              </div>
              <pre ref={logRef} className="logbox max-h-[440px] min-h-[280px] whitespace-pre-wrap break-words">
                {fullLog ? fullLog.text || '（空日志）' : '（加载中…）'}
              </pre>
              {fullLog && fullLog.logPath ? <p className="m-0 break-all font-mono text-[10px] text-[var(--fg-4)]">日志文件：{fullLog.logPath}</p> : null}
            </>
          )}
        </div>
      </Modal>

      {/* ===== 样例预览弹窗 ===== */}
      <Modal
        open={samplesOpen}
        onOpenChange={(v) => { if (!v) setSamplesOpen(false); }}
        title="预览样例"
        description="查看样例的输入内容、素材与提示词，并可直接播放成片；点「一键试用」把样例填充到创建表单。"
        size="5xl"
        footer={
          <>
            {activeSample ? (
              <Button variant="primary" size="md" loading={sampleBusy} disabled={sampleBusy} onClick={() => trySample(activeSample)}>
                <WandSparkles size={14} /> 一键试用
              </Button>
            ) : null}
            <Button variant="secondary" size="md" onClick={() => setSamplesOpen(false)}>关闭</Button>
          </>
        }
      >
        {!samples.length ? (
          <EmptyState icon={Eye} title="暂无样例" description="把样例文件放到 public/samples/<id>/ 并编写 sample.json 后，样例会出现在这里。" />
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            {/* 样例列表：小屏横向滑动，避免纵向列表把播放区域挤到屏幕外 */}
            <div className="flex min-w-0 gap-2 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible xl:pb-0">
              {samples.map((s) => {
                const p = s.style || {};
                const active = activeSample && activeSample.id === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSampleId(s.id)}
                    className={
                      'flex w-[230px] shrink-0 items-center gap-3 rounded-xl border p-2 text-left transition-colors xl:w-auto xl:shrink ' +
                      (active ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]' : 'border-[var(--line)] bg-white/[0.02] hover:border-[var(--line-strong)]')
                    }
                  >
                    <div className="h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-black/40">
                      <video src={s.video} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-[var(--fg)]">{s.name || '（未命名）'}</div>
                      <div className="truncate text-[11px] text-[var(--fg-3)]">风格：{p.custom_style ? '自定义' : (p.cn || p.slug || '—')}</div>
                      <div className="truncate text-[11px] text-[var(--fg-4)]">{s.prompt || '（无提示词）'}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 样例详情 */}
            {activeSample ? (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--fg)]">{activeSample.name || '（未命名）'}</span>
                  <StatusPill status="done">完成</StatusPill>
                </div>

                {/* 成片播放：限制最大高度并禁止 iOS 自动全屏，小屏下不再撑满整屏 */}
                <div className="flex w-full items-center justify-center overflow-hidden rounded-xl border border-[var(--line)] bg-black/40">
                  <video
                    src={activeSample.video}
                    controls
                    playsInline
                    preload="metadata"
                    className="mx-auto h-auto max-h-[38vh] w-full bg-black object-contain sm:max-h-[46vh] xl:max-h-[56vh]"
                  />
                </div>

                {/* 风格 */}
                <div>
                  <div className="mb-1 text-[11px] font-medium text-[var(--fg-4)]">风格</div>
                  {(() => {
                    const p = activeSample.style || {};
                    if (p.custom_style) return <div className="logbox">{p.custom_style}</div>;
                    return <Badge tone="accent">{p.cn || p.slug || '—'}{p.cat ? ' · ' + p.cat : ''}</Badge>;
                  })()}
                </div>

                {/* 提示词 */}
                <div>
                  <div className="mb-1 text-[11px] font-medium text-[var(--fg-4)]">提示词</div>
                  <div className="logbox max-h-[120px]">{activeSample.prompt || '（无）'}</div>
                </div>

                {/* 素材 */}
                <div>
                  <div className="mb-1 text-[11px] font-medium text-[var(--fg-4)]">素材（{(activeSample.materials || []).length}）</div>
                  {(() => {
                    const refs = activeSample.materials || [];
                    if (!refs.length) return <span className="text-[11px] text-[var(--fg-4)]">无素材</span>;
                    return (
                      <div className="flex flex-wrap gap-1.5">
                        {refs.map((m, i) =>
                          PREVIEW_KINDS.has(m.type) && m.url ? (
                            <MaterialTile key={i} kind={m.type} name={m.name} src={m.url} />
                          ) : (
                            <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--line)] bg-white/[0.03] px-2.5 text-[11.5px] text-[var(--fg-2)]">
                              <span className="truncate">[{KIND_LABEL[m.type] || '文件'}] {m.name}</span>
                            </span>
                          ),
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Modal>
    </div>
  );
}
