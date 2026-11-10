// 无限・卷轴：写小说工作台
// 顶部横置菜单栏分四板块：章节（写正文）/ 大纲（总纲·卷纲·章纲）/ 角色 / 记忆。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, ChevronLeft, ChevronRight, Download, Feather, FileText, FolderOpen, GripVertical, Layers, PenLine,
  Plus, RefreshCw, Save, Search, Sparkles, Square, Trash2, Users, WandSparkles, Workflow, X,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, EmptyState, Field, Input, Spinner, StatusPill, Textarea } from '../components/ui.jsx';
import { Modal } from '../components/overlays.jsx';
import SkillPipelinePanel from '../components/SkillPipelinePanel.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useJobs } from '../components/simpleStudio.jsx';
import { useToast } from '../components/toast.jsx';

const STEP_LABEL = { outline: '总纲', volumes: '分卷', chapters: '章纲', write: '正文', start: '整本生成', restart: '全部重新生成', all: '全部大纲' };

function safeFileName(s) {
  return String(s || '未命名小说').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || '未命名小说';
}

function downloadTxt(filename, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith('.txt') ? filename : filename + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// groups: [{ seq, title, items: [chapter] }]
function buildBookText({ bookName, idea, groups }) {
  const lines = [String(bookName || '未命名小说')];
  if (idea) lines.push('', String(idea).trim());
  for (const g of groups) {
    const items = g.items.filter((c) => String(c.novel || '').trim());
    if (!items.length) continue;
    lines.push('', '====================', `第${g.seq}卷${g.title ? ' ' + g.title : ''}`, '====================');
    for (const c of items) lines.push('', c.title || '未命名', '', String(c.novel).trim());
  }
  return lines.join('\n') + '\n';
}

function buildChapterText(c) {
  return [c.title || '未命名', '', String(c.novel || '').trim()].join('\n') + '\n';
}

const PANELS = [
  { key: 'chapters', label: '章节', icon: PenLine },
  { key: 'outline', label: '大纲', icon: Layers },
  { key: 'characters', label: '角色', icon: Users },
  { key: 'memory', label: '记忆', icon: FolderOpen },
];

function NewNovelModal({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) { setName(''); setIdea(''); }
  }, [open]);

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const p = await api.post('/api/projects', { name: name.trim(), type: 'novel', idea: idea.trim() });
      onCreate(p);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="新建小说">
      <div className="flex flex-col gap-3">
        <Field label="小说标题" required>
          <Input autoFocus placeholder="比如：凡人修仙传" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="中心思想 / 故事梗概">
          <Textarea
            rows={5}
            placeholder="主角是谁、想做什么、遇到什么障碍、这本书卖什么卖点……一两段话就行，Agent 会在此基础上展开成完整大纲。"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
          />
        </Field>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? <Spinner size={14} /> : <Plus size={14} />}
            创建
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// —— 大纲编辑器（总纲/卷纲/章纲共用）——
function EditorTab({ label, value, onChange, onSave, emptyHint }) {
  const [editing, setEditing] = useState(value == null || value === '');
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setEditing(value == null || value === ''); setDraft(value || ''); }, [value]);
  if (editing) {
    return (
      <div className="flex flex-col gap-3">
        <Textarea rows={14} placeholder={emptyHint} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[13px]" />
        <div className="flex justify-end gap-2">
          {value ? <Button variant="ghost" size="sm" onClick={() => { setDraft(value); setEditing(false); }}>撤销</Button> : null}
          <Button size="sm" onClick={() => { setEditing(false); onSave(draft); }}><Save size={12} />保存</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <pre className="whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-black/30 p-4 text-[13px] leading-relaxed">{value}</pre>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => setEditing(true)}><Feather size={12} />编辑</Button>
      </div>
    </div>
  );
}

export default function NovelPage({ onOpenAgentProject }) {
  const toast = useToast();
  const [novels, setNovels] = useState([]);
  const [selected, setSelected] = useState(null); // { id, project, structure, characters, memory, chapters, activeJob }
  const [showNew, setShowNew] = useState(false);
  const [panel, setPanel] = useState('chapters');
  const [saving, setSaving] = useState(false);
  // 标题/中心思想编辑（Hook 必须在任何提前 return 之前）
  const [editingInfo, setEditingInfo] = useState(false);
  const [infoName, setInfoName] = useState('');
  const [infoIdea, setInfoIdea] = useState('');
  // 小说技能配置（流水线编排 → 生成小说 环节）
  const [skillOpen, setSkillOpen] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [savedCfg, setSavedCfg] = useState(null);
  const [savingCfg, setSavingCfg] = useState(false);

  // jobs 轮询（useJobs 内部已带 4s 轮询）
  const { jobs: projectJobs, reloadJobs } = useJobs(selected?.id);
  const novelJobs = useMemo(() => (projectJobs || []).filter((j) => j.type === 'novel'), [projectJobs]);
  const running = novelJobs.find((j) => j.status === 'running' || j.status === 'queued');

  const loadNovels = useCallback(async () => {
    const arr = await api.get('/api/projects?type=novel');
    setNovels(Array.isArray(arr?.items) ? arr.items : (Array.isArray(arr) ? arr : []));
  }, []);

  const loadSelected = useCallback(async (id) => {
    const data = await api.get('/api/projects/' + id + '/novel');
    setSelected({ ...data, id: data?.project?.id || id });
  }, []);

  async function delNovel(n) {
    if (!(await toast.confirm('删除「' + (n.name || '未命名') + '」及其全部大纲、角色、章节正文？此操作不可逆。', { danger: true }))) return;
    try {
      await api.del('/api/projects/' + n.id);
      toast.success('已删除');
      if (selected?.id === n.id) setSelected(null);
      loadNovels();
    } catch (e) {
      toast.error('删除失败：' + (e?.message || String(e)));
    }
  }

  useEffect(() => { loadNovels(); }, [loadNovels]);

  // 任务结束（完成/失败/取消）后刷新，拿到新落盘的正文
  const jobsSig = novelJobs.map((j) => j.id + ':' + j.status).join(',');
  useEffect(() => {
    if (!selected?.id) return;
    const hasFinished = novelJobs.some((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
    if (!hasFinished) return;
    const t = setTimeout(() => { loadSelected(selected.id); loadNovels(); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsSig]);

  // 任务运行中每 5 秒刷新一次，实时看到新生成的卷/章节/正文
  const runningJobId = running ? running.id : '';
  useEffect(() => {
    if (!selected?.id || !runningJobId) return;
    const t = setInterval(() => { loadSelected(selected.id).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [selected?.id, runningJobId, loadSelected]);

  async function startStep(step, chapter) {
    if (!selected) return;
    try {
      await api.post('/api/projects/' + selected.id + '/novel', { step, chapter: chapter || '', message: '' });
      toast.success('开始' + (STEP_LABEL[step] || step) + (chapter ? '「' + chapter + '」' : '') + '...');
      reloadJobs();
    } catch (e) {
      if (String(e?.message || '').includes('ALREADY_RUNNING')) {
        toast.error('该小说正在生成中，请等它结束或先停止');
      } else {
        toast.error('启动失败：' + (e?.message || String(e)));
      }
    }
  }

  async function saveStructure(k, v) {
    if (!selected) return;
    setSaving(true);
    try {
      const patch = { structure: { ...(selected.structure || {}), [k]: v } };
      const data = await api.put('/api/projects/' + selected.id + '/novel', patch);
      setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
      toast.success('已保存');
    } catch (e) {
      toast.error('保存失败：' + (e?.message || String(e)));
    } finally {
      setSaving(false);
    }
  }

  async function updateProjectNameIdea(name, idea) {
    if (!selected) return;
    await api.patch('/api/projects/' + selected.id, { name, idea });
    toast.success('已更新');
    loadNovels();
    loadSelected(selected.id);
  }

  async function saveCharacters(next) {
    if (!selected) return;
    const data = await api.put('/api/projects/' + selected.id + '/novel', { characters: next });
    setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
    toast.success('角色已更新');
  }

  async function saveMemory(next) {
    if (!selected) return;
    const data = await api.put('/api/projects/' + selected.id + '/novel', { memory: next });
    setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
    toast.success('记忆已更新');
  }

  async function saveVolumes(next) {
    if (!selected) return;
    try {
      const data = await api.put('/api/projects/' + selected.id + '/novel', { volumes: next });
      setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
      toast.success('分卷已更新');
    } catch (e) {
      toast.error('保存失败：' + (e?.message || String(e)));
    }
  }

  async function importToAgent() {
    if (!selected) return;
    try {
      const r = await api.post('/api/projects/' + selected.id + '/novel/import');
      toast.success('已创建视频项目：' + r.name + `（迁移 ${r.chapters || 0} 章 / ${r.characters || 0} 个角色）`);
      if (onOpenAgentProject) onOpenAgentProject(r.id);
    } catch (e) {
      toast.error('小说转视频失败：' + (e?.message || String(e)));
    }
  }

  async function stopJob() {
    if (!selected?.id || !running?.id) return;
    try {
      await api.post('/api/projects/' + selected.id + '/jobs/' + running.id + '/cancel');
      toast.success('已停止生成');
      reloadJobs();
    } catch (e) {
      toast.error('停止失败：' + (e?.message || String(e)));
    }
  }

  // —— 小说技能配置（流水线编排 → 生成小说 环节）——
  async function openSkillCfg() {
    setSkillOpen(true);
    if (cfg) return;
    try {
      const c = await api.get('/api/config');
      setCfg(c);
      setSavedCfg(c);
    } catch (e) {
      toast.error('读取配置失败：' + (e?.message || String(e)));
    }
  }

  function closeSkillCfg() {
    setSkillOpen(false);
    if (savedCfg) setCfg(savedCfg); // 未保存的改动回滚
  }

  async function saveSkillCfg() {
    if (!cfg) return;
    setSavingCfg(true);
    try {
      const s = await api.put('/api/config', cfg);
      setCfg(s);
      setSavedCfg(s);
      toast.success('小说技能配置已保存');
      setSkillOpen(false);
    } catch (e) {
      toast.error('保存失败：' + (e?.message || String(e)));
    } finally {
      setSavingCfg(false);
    }
  }

  // —— 列表态 ——
  if (!selected) {
    return (
      <>
        <PageHeader
          title="无限・卷轴"
          subtitle="写小说：逐章正文 · 大纲 · 角色 · 上下文记忆"
          icon={<Feather size={22} className="text-[var(--accent)]" />}
          actions={<Button onClick={() => setShowNew(true)}><Plus size={14} />新建小说</Button>}
        />
        {novels.length === 0 ? (
          <div className="panel p-6">
            <EmptyState icon={BookOpen} title="还没有小说" description="点击右上角「新建小说」开始" />
          </div>
        ) : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {novels.map((n) => (
              <article
                key={n.id}
                className="panel panel-hover group relative flex flex-col overflow-hidden"
              >
                <button type="button" onClick={() => loadSelected(n.id)} className="block w-full text-left">
                  <div className="relative flex aspect-[16/9] flex-col items-center justify-center gap-2 overflow-hidden bg-[radial-gradient(120%_120%_at_30%_0%,rgba(255,255,255,.05),transparent_60%)]">
                    <Feather size={24} className="text-[var(--fg-4)]" />
                    <span className="font-mono text-[10px] tracking-[.14em] text-[var(--fg-4)]">NOVEL</span>
                  </div>
                  <div className="flex flex-col gap-1.5 p-3.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-[var(--fg)]">{n.name || '未命名'}</span>
                    </div>
                    {n.idea ? (
                      <p className="m-0 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--fg-3)]">{n.idea}</p>
                    ) : null}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-[10.5px] text-[var(--fg-4)]">打开写作</span>
                      <Feather size={13} className="text-[var(--fg-4)] opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={'删除小说 ' + (n.name || '未命名')}
                  onClick={() => delNovel(n)}
                  className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:border-[color-mix(in_srgb,var(--danger)_45%,transparent)] hover:text-[var(--danger)] group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </article>
            ))}
          </div>
        )}
        <NewNovelModal open={showNew} onClose={() => setShowNew(false)} onCreate={(p) => loadSelected(p.id)} />
      </>
    );
  }

  const structure = selected.structure || {};
  const characters = selected.characters || [];
  const memory = selected.memory || [];
  const chapters = selected.chapters || [];

  function openEditInfo() {
    setInfoName(selected.project?.name || '');
    setInfoIdea(selected.project?.idea || '');
    setEditingInfo(true);
  }
  async function saveInfo() {
    if (!infoName.trim()) { toast.error('标题不能为空'); return; }
    await updateProjectNameIdea(infoName.trim(), infoIdea.trim());
    setEditingInfo(false);
  }

  return (
    <>
      <PageHeader
        title={selected.project?.name || '未命名'}
        subtitle={selected.project?.idea ? selected.project.idea.slice(0, 60) + (selected.project.idea.length > 60 ? '…' : '') : '（暂无中心思想）'}
        icon={<Feather size={22} className="text-[var(--accent)]" />}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>← 返回列表</Button>
            <Button variant="ghost" size="sm" onClick={openEditInfo}><Feather size={12} />编辑信息</Button>
            {running ? <Button variant="ghost" size="sm" onClick={stopJob}><Square size={12} />停止生成</Button> : null}
            <Button size="sm" onClick={importToAgent} title="把当前小说的章节正文、大纲、角色设定迁移到 Agent 无限创作，开始生成视频">
              <Sparkles size={12} />小说转视频
            </Button>
          </div>
        }
      />

      {editingInfo ? (
        <div className="panel mb-4 flex flex-col gap-3 p-4">
          <Field label="小说标题" required>
            <Input value={infoName} onChange={(e) => setInfoName(e.target.value)} />
          </Field>
          <Field label="中心思想 / 故事梗概">
            <Textarea rows={3} value={infoIdea} onChange={(e) => setInfoIdea(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditingInfo(false)}>取消</Button>
            <Button size="sm" onClick={saveInfo}><Save size={12} />保存</Button>
          </div>
        </div>
      ) : null}

      {running ? (
        <div className="panel mb-4 flex items-center gap-3 px-4 py-3">
          <StatusPill status={running.status} />
          <span className="text-sm">
            正在生成【{STEP_LABEL[(running.checkpoint || {}).step] || '大纲'}】
            {running.phase ? <span className="text-[var(--fg-3)]"> · {running.phase}</span> : null}
          </span>
          <Button variant="ghost" size="sm" onClick={stopJob}><Square size={12} />停止</Button>
        </div>
      ) : null}

      {/* 顶部横置菜单栏 */}
      <div className="panel mb-4 flex items-center gap-1 overflow-x-auto p-1.5">
        {PANELS.map((p) => {
          const Icon = p.icon;
          const active = panel === p.key;
          const count = p.key === 'chapters' ? chapters.length : p.key === 'characters' ? characters.length : p.key === 'memory' ? memory.length : null;
          return (
            <button
              key={p.key}
              type="button"
              data-active={active}
              onClick={() => setPanel(p.key)}
              className={
                'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors '
                + (active ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]' : 'text-[var(--fg-3)] hover:bg-white/[0.05] hover:text-[var(--fg)]')
              }
            >
              <Icon size={14} />{p.label}
              {count != null && count > 0 ? <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] text-[var(--fg-3)]">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {panel === 'chapters' ? (
        <ChaptersPanel
          projectId={selected.id}
          projectName={selected.project?.name || ''}
          projectIdea={selected.project?.idea || ''}
          chapters={chapters}
          volumes={selected.volumes || []}
          running={!!running}
          onRefresh={() => loadSelected(selected.id)}
          onSaveVolumes={saveVolumes}
          onStart={() => startStep('start')}
          onRestart={() => startStep('restart')}
          onStop={stopJob}
          onWriteOne={(title) => startStep('write', title)}
          onOpenSkillCfg={openSkillCfg}
        />
      ) : null}

      {panel === 'outline' ? (
        <OutlinePanel
          structure={structure}
          running={!!running}
          onSave={saveStructure}
          onGenerate={startStep}
        />
      ) : null}

      {panel === 'characters' ? (
        <div className="grid gap-4 lg:grid-cols-[1fr]">
          <CharacterPanel characters={characters} onChange={saveCharacters} />
        </div>
      ) : null}

      {panel === 'memory' ? (
        <div className="grid gap-4 lg:grid-cols-[1fr]">
          <MemoryPanel memory={memory} onChange={saveMemory} />
        </div>
      ) : null}

      <NewNovelModal open={showNew} onClose={() => setShowNew(false)} onCreate={(p) => loadSelected(p.id)} />

      <Modal
        open={skillOpen}
        onOpenChange={(o) => !o && closeSkillCfg()}
        title="小说技能配置"
        description="无限·卷轴生成时优先加载「生成小说」环节的技能：第一个为主技能，其余为备用；开启自动匹配后还可从技能目录挑选其它合适技能。"
        size="2xl"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={closeSkillCfg}>取消</Button>
            <Button variant="primary" size="md" loading={savingCfg} disabled={!cfg} onClick={saveSkillCfg}>保存配置</Button>
          </>
        }
      >
        {cfg ? (
          <SkillPipelinePanel cfg={cfg} setCfg={setCfg} setSavedCfg={setSavedCfg} onlyNode="novel" />
        ) : (
          <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--fg-3)]">
            <Spinner size={15} /> 加载配置…
          </div>
        )}
      </Modal>
    </>
  );
}

// —— 章节板块（按卷分组，每卷显示本卷卷纲）——
function ChaptersPanel({ projectId, projectName, projectIdea, chapters, volumes, running, onRefresh, onSaveVolumes, onStart, onRestart, onStop, onWriteOne, onOpenSkillCfg }) {
  const toast = useToast();
  const [showPreview, setShowPreview] = useState(false);
  const [editing, setEditing] = useState(null); // { id?, title, novel, volume, outline }
  const [editingVolume, setEditingVolume] = useState(null); // { seq, title, outline }
  const [volTitle, setVolTitle] = useState('');
  const [volOutline, setVolOutline] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNovel, setDraftNovel] = useState('');
  const [draftVolume, setDraftVolume] = useState(1);
  const [draftOutline, setDraftOutline] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [order, setOrder] = useState(chapters);
  useEffect(() => setOrder(chapters), [chapters]);

  function openEdit(c) {
    setEditing(c);
    setDraftTitle(c.title || '');
    setDraftNovel(c.novel || '');
    setDraftVolume(c.volume || 1);
    setDraftOutline(c.outline || '');
  }
  function close() { setEditing(null); }

  async function saveChapter() {
    setBusy(true);
    try {
      const body = { title: draftTitle.trim(), novel: draftNovel, volume: Number(draftVolume) || 1, outline: draftOutline };
      if (editing.id) {
        await api.patch('/api/projects/' + projectId + '/chapters/' + editing.id, body);
      } else {
        await api.post('/api/projects/' + projectId + '/chapters', body);
      }
      toast.success('已保存');
      close();
      onRefresh();
    } catch (e) {
      toast.error(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」？此操作不可逆。', { danger: true }))) return;
    try {
      await api.del('/api/projects/' + projectId + '/chapters/' + c.id);
      toast.success('已删除');
      onRefresh();
    } catch (e) {
      toast.error(e?.message || String(e));
    }
  }

  async function persistReorder(list) {
    try {
      await api.patch('/api/projects/' + projectId + '/chapters', { ids: list.map((c) => c.id) });
      onRefresh();
    } catch (e) {
      toast.error(e?.message || String(e));
      onRefresh();
    }
  }

  function handleDrop(to) {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    persistReorder(next);
  }

  // 按卷分组：以结构化 volumes 为准，章节按 volume 归入；老数据（无 volumes）按章节的 volume 值兜底分组
  const groups = useMemo(() => {
    const map = new Map();
    for (const v of volumes || []) {
      const seq = Number(v.seq) || 1;
      map.set(seq, { seq, title: v.title || '', outline: v.outline || '', items: [] });
    }
    for (const c of order) {
      const seq = Number(c.volume) || 1;
      if (!map.has(seq)) map.set(seq, { seq, title: '', outline: '', items: [] });
      map.get(seq).items.push(c);
    }
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }, [order, volumes]);

  function openEditVolume(g) {
    setEditingVolume(g);
    setVolTitle(g.title || '');
    setVolOutline(g.outline || '');
  }
  async function saveVolume() {
    const seq = Number(editingVolume?.seq) || 1;
    const base = (volumes || []).map((v) => ({ ...v }));
    const idx = base.findIndex((v) => Number(v.seq) === seq);
    const patch = { seq, title: volTitle.trim(), outline: volOutline };
    if (idx >= 0) base[idx] = { ...base[idx], ...patch };
    else base.push(patch);
    base.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    await onSaveVolumes(base);
    setEditingVolume(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onOpenSkillCfg} title="配置无限·卷轴生成小说时使用的写作 Skill">
          <Workflow size={14} />小说技能配置
        </Button>
        <Button variant="primary" onClick={onStart} disabled={running}>
          <Sparkles size={14} />{running ? '生成中…' : '开始生成 / 继续'}
        </Button>
        <Button
          variant="secondary"
          disabled={running}
          onClick={async () => {
            if (!(await toast.confirm('「全部重新生成」会清空当前的大纲、角色、卷、章节和正文，从零重新生成，确定？', { danger: true }))) return;
            onRestart();
          }}
        >
          <RefreshCw size={14} />全部重新生成
        </Button>
        <Button
          variant="secondary"
          disabled={running || !chapters.some((c) => String(c.novel || '').trim())}
          title="把已写好的全部章节导出为一个 txt 文件"
          onClick={() => {
            const text = buildBookText({ bookName: projectName, idea: projectIdea, groups });
            downloadTxt(safeFileName(projectName), text);
          }}
        >
          <Download size={14} />导出全文 TXT
        </Button>
        <Button variant="secondary" disabled={running || chapters.length === 0} onClick={() => setShowPreview(true)}>
          <BookOpen size={14} />预览
        </Button>
        {running ? (
          <Button variant="danger" onClick={onStop}><Square size={13} />停止</Button>
        ) : null}
        <span className="text-[12px] text-[var(--fg-4)]">
          自动依次生成：总纲 → 角色 → 分卷 → 章节 → 章纲 → 正文；中断后再点「开始生成 / 继续」会从断点续跑
        </span>
      </div>

      {order.length === 0 && groups.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={PenLine}
            title="还没有章节"
            description="点「开始生成」让 Agent 按 总纲 → 角色 → 分卷 → 章节 → 章纲 → 正文 自动生成整本小说。"
            action={<Button variant="primary" onClick={onStart} disabled={running}><Sparkles size={14} />开始生成</Button>}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.seq} className="panel p-4">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="m-0 text-[15px] font-semibold text-[var(--fg)]">
                      第{g.seq}卷{g.title ? ' · ' + g.title : ''}
                    </h3>
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--fg-3)]">{g.items.length} 章</span>
                  </div>
                  {g.outline ? (
                    <p className="m-0 mt-1.5 whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-black/20 px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--fg-2)]">
                      <span className="text-[var(--fg-4)]">本卷卷纲：</span>{g.outline}
                    </p>
                  ) : (
                    <p className="m-0 mt-1.5 text-[11.5px] text-[var(--fg-4)]">还没有本卷卷纲（点「编辑卷」补充，或让 Agent 生成）</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => openEditVolume(g)}><Feather size={12} />编辑卷</Button>
                </div>
              </div>

              {g.items.length === 0 ? (
                <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-4 text-center text-[11.5px] text-[var(--fg-4)]">本卷还没有章节</p>
              ) : (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                  {g.items.map((c) => {
                    const i = order.indexOf(c);
                    const wordCount = String(c.novel || '').length;
                    return (
                      <article
                        key={c.id}
                        onClick={() => openEdit(c)}
                        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overIndex !== i) setOverIndex(i); }}
                        onDrop={() => handleDrop(i)}
                        className={
                          'panel panel-hover group relative flex cursor-pointer flex-col gap-2 p-4 '
                          + (overIndex === i && dragIndex !== null && dragIndex !== i ? 'border-[var(--accent)]' : '')
                          + (dragIndex === i ? ' opacity-60' : '')
                        }
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-start gap-2">
                            <button
                              type="button"
                              draggable
                              title="拖拽排序"
                              aria-label="拖拽排序"
                              onClick={(e) => e.stopPropagation()}
                              onDragStart={(e) => { setDragIndex(i); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch {} }}
                              onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                              className="mt-0.5 cursor-grab text-[var(--fg-4)] hover:text-[var(--fg)] active:cursor-grabbing"
                            >
                              <GripVertical size={14} />
                            </button>
                            <div className="min-w-0">
                              <p className="m-0 font-mono text-[9.5px] tracking-[.14em] text-[var(--fg-4)]">CHAPTER {String(i + 1).padStart(2, '0')}</p>
                              <h3 className="m-0 mt-0.5 truncate text-[14px] font-medium" title={c.title}>{c.title || '未命名'}</h3>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button type="button" aria-label="删除" onClick={(e) => { e.stopPropagation(); removeChapter(c); }} className="rounded p-1 text-[var(--fg-3)] hover:bg-black/30"><Trash2 size={13} /></button>
                          </div>
                        </div>

                        {c.outline ? (
                          <p className="m-0 line-clamp-3 rounded-lg border border-[var(--line)] bg-black/20 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[var(--fg-3)]" title={c.outline}>
                            <span className="text-[var(--fg-4)]">章纲：</span>{c.outline}
                          </p>
                        ) : (
                          <p className="m-0 text-[11px] text-[var(--fg-4)]">还没有本章章纲</p>
                        )}
                        <p className="m-0 line-clamp-3 text-[12px] leading-relaxed text-[var(--fg-3)]">
                          {wordCount ? String(c.novel || '').slice(0, 160) : '（还没有正文）'}
                        </p>
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="font-mono text-[10.5px] text-[var(--fg-4)]">{wordCount ? wordCount.toLocaleString() + ' 字' : '未写'}</span>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!wordCount}
                              title={wordCount ? '导出本章为 txt' : '本章还没有正文'}
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadTxt(safeFileName(projectName + '-' + (c.title || '未命名')), buildChapterText(c));
                              }}
                            >
                              <Download size={12} />导出
                            </Button>
                            <Button size="sm" variant="ghost" disabled={running} onClick={(e) => { e.stopPropagation(); onWriteOne(c.title); }}>
                              <WandSparkles size={12} />重新生成
                            </Button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      <Modal
        open={!!editing}
        onOpenChange={(o) => !o && !busy && close()}
        title={editing?.id ? '编辑章节' : '新增章节'}
        size="xl"
        footer={
          <>
            <Button variant="ghost" size="md" disabled={busy} onClick={close}>取消</Button>
            <Button variant="primary" size="md" loading={busy} onClick={saveChapter}>保存本章</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="w-28 shrink-0">
              <Field label="所属卷号">
                <Input type="number" min={1} value={String(draftVolume)} onChange={(e) => setDraftVolume(Number(e.target.value) || 1)} placeholder="1" />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="章节标题" hint="留空自动命名为「第 N 章」">
                <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="第1章 意外穿越" />
              </Field>
            </div>
          </div>
          <Field label="本章章纲" hint="这一章要写什么：本章目标 / 阻碍 / 变化 / 章末钩子">
            <Textarea rows={4} value={draftOutline} onChange={(e) => setDraftOutline(e.target.value)} placeholder="本章章纲（这一章要写什么）…" />
          </Field>
          <Field label="本章正文" hint={draftNovel ? draftNovel.length.toLocaleString() + ' 字' : undefined}>
            <Textarea rows={14} value={draftNovel} onChange={(e) => setDraftNovel(e.target.value)} placeholder="粘贴或编辑本章正文…" className="min-h-[240px] font-mono text-[13px]" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!editingVolume}
        onOpenChange={(o) => !o && setEditingVolume(null)}
        title={'第' + (Number(editingVolume?.seq) || 1) + '卷 · 卷纲'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setEditingVolume(null)}>取消</Button>
            <Button variant="primary" size="md" onClick={saveVolume}>保存卷</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="卷名" hint="如「山门」「初入修界」">
            <Input value={volTitle} onChange={(e) => setVolTitle(e.target.value)} placeholder="第一卷 山门" />
          </Field>
          <Field label="本卷卷纲" hint="这一卷要写什么：核心目标 / 主要冲突 / 卷末变化 / 覆盖第几章到第几章">
            <Textarea rows={8} value={volOutline} onChange={(e) => setVolOutline(e.target.value)} placeholder="本卷卷纲（这一卷要写什么）…" />
          </Field>
        </div>
      </Modal>

      <PreviewModal
        open={showPreview}
        onClose={() => setShowPreview(false)}
        bookName={projectName}
        groups={groups}
      />
    </div>
  );
}

// —— 在线预览：左侧卷/章目录，右侧一页一章，翻页带翻书动效 ——
function PreviewModal({ open, onClose, bookName, groups }) {
  const pages = useMemo(
    () => (groups || []).flatMap((g) => g.items.map((c) => ({ chapter: c, volSeq: g.seq, volTitle: g.title || '' }))),
    [groups],
  );
  const [page, setPage] = useState(1); // 1-based
  const [dir, setDir] = useState('next');
  const [flipKey, setFlipKey] = useState(0);
  const [jump, setJump] = useState('1');
  const [q, setQ] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setPage(1);
    setJump('1');
    setQ('');
    setDir('next');
    setFlipKey((k) => k + 1);
  }, [open]);
  useEffect(() => { setJump(String(page)); }, [page]);

  const total = pages.length;
  const current = pages[page - 1];

  function go(target, from) {
    const n = Math.min(Math.max(Number(target) || 1, 1), total || 1);
    // 翻页后正文滚动条回到顶部
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setDir(from || (n >= page ? 'next' : 'prev'));
    setPage(n);
    setFlipKey((k) => k + 1);
  }

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(Math.min(page + 1, total), 'next'); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(Math.max(page - 1, 1), 'prev'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page, total]);

  // 目录筛选：按章节标题过滤，仍按卷分组展示
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return groups || [];
    return (groups || [])
      .map((g) => ({ ...g, items: g.items.filter((c) => String(c.title || '').toLowerCase().includes(kw)) }))
      .filter((g) => g.items.length);
  }, [groups, q]);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={'预览 · ' + (bookName || '未命名小说')}
      size="5xl"
      className="h-[86vh]"
      bodyClassName="!overflow-hidden !p-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* 顶部页码栏 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
          <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => go(page - 1, 'prev')}>
            <ChevronLeft size={13} />上一页
          </Button>
          <span className="text-[12px] text-[var(--fg-3)]">第</span>
          <input
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') go(jump); }}
            inputMode="numeric"
            aria-label="跳转到页码"
            className="h-7 w-14 rounded-md border border-[var(--line)] bg-white/[0.04] px-2 text-center text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
          />
          <span className="text-[12px] text-[var(--fg-3)]">/ {total} 页</span>
          <Button size="xs" variant="secondary" disabled={!total} onClick={() => go(jump)}>跳转</Button>
          <Button size="xs" variant="ghost" disabled={page >= total} onClick={() => go(page + 1, 'next')}>
            下一页<ChevronRight size={13} />
          </Button>
          <span className="ml-auto text-[11px] text-[var(--fg-4)]">共 {total} 章 · 一页一章 · ← → 翻页</span>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：目录 */}
          <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--line)]">
            <div className="border-b border-[var(--line)] p-2.5">
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-4)]" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="筛选目录…"
                  className="h-8 w-full rounded-lg border border-[var(--line)] bg-white/[0.035] pl-8 pr-2 text-[12.5px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <p className="m-0 px-2 py-4 text-center text-[11.5px] text-[var(--fg-4)]">没有匹配的章节</p>
              ) : null}
              {filtered.map((g) => (
                <div key={g.seq} className="mb-2">
                  <p className="m-0 px-2 py-1 text-[10.5px] uppercase tracking-[.14em] text-[var(--fg-4)]">
                    第{g.seq}卷{g.title ? ' · ' + g.title : ''}
                  </p>
                  {g.items.map((c) => {
                    const idx = pages.findIndex((p) => p.chapter.id === c.id) + 1;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => go(idx, idx >= page ? 'next' : 'prev')}
                        className={
                          'block w-full truncate rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors '
                          + (idx === page
                            ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                            : 'text-[var(--fg-2)] hover:bg-white/[0.05]')
                        }
                      >
                        {c.title || '未命名'}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </aside>

          {/* 右：正文 */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6" style={{ perspective: '1800px' }}>
              {current ? (
                <div key={page + ':' + flipKey} className={dir === 'prev' ? 'novel-flip-prev' : 'novel-flip-next'}>
                  <p className="m-0 font-mono text-[10px] tracking-[.16em] text-[var(--fg-4)]">
                    第{current.volSeq}卷{current.volTitle ? ' · ' + current.volTitle : ''} · PAGE {page}/{total}
                  </p>
                  <h3 className="m-0 mt-1.5 text-[19px] font-semibold text-[var(--fg)]">{current.chapter.title || '未命名'}</h3>
                  <article className="mt-4 whitespace-pre-wrap text-[14.5px] leading-[2] text-[var(--fg-2)]">
                    {String(current.chapter.novel || '').trim() || '（本章还没有正文）'}
                  </article>
                </div>
              ) : (
                <p className="text-[13px] text-[var(--fg-4)]">还没有章节</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </Modal>
  );
}

// —— 大纲板块：只有总纲（卷纲在「章节」板块按卷展示，章纲绑定到每章）——
function OutlinePanel({ structure, running, onSave, onGenerate }) {
  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)]">
        <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-[var(--accent)]">
          <BookOpen size={13} />总纲
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={running} onClick={() => onGenerate('outline')}>
            <WandSparkles size={12} />生成总纲
          </Button>
        </div>
      </div>
      <EditorTab
        value={structure.outline}
        onSave={(v) => onSave('outline', v)}
        emptyHint={'总纲应包含：一句话 hook · 题材与卖点 · 故事引擎 · 目标长度（短/中/长/连载）· 第一卷最小目标与卷末变化'}
      />
    </div>
  );
}

// —— 角色管理 ——
function CharacterPanel({ characters, onChange }) {
  const [next, setNext] = useState(null);
  const [draft, setDraft] = useState({ name: '', role: '', description: '', notes: '' });

  useEffect(() => {
    if (next === null) setDraft({ name: '', role: '', description: '', notes: '' });
  }, [next]);

  function startAdd() { setNext({ id: '', name: '', role: '', description: '', notes: '' }); }
  function startEdit(c) { setNext({ ...c }); }
  function cancel() { setNext(null); }

  function save() {
    if (!next) return;
    if (!next.name.trim() && !next.role.trim() && !next.description.trim()) return cancel();
    const arr = next.id
      ? characters.map((c) => (c.id === next.id ? { ...c, ...next } : c))
      : [...characters, { ...next }];
    onChange(arr);
    setNext(null);
  }

  function remove(id) { onChange(characters.filter((c) => c.id !== id)); }

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium"><Users size={14} className="text-[var(--accent)]" />角色 <Badge size="sm">{characters.length}</Badge></h3>
        <Button size="sm" variant="ghost" onClick={startAdd} disabled={next !== null}><Plus size={12} />添加</Button>
      </div>
      {next !== null ? (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-dashed border-[var(--line)] bg-black/20 p-3">
          <Field label="名字"><Input value={next.name} onChange={(e) => setNext({ ...next, name: e.target.value })} placeholder="张三" /></Field>
          <Field label="定位"><Input value={next.role} onChange={(e) => setNext({ ...next, role: e.target.value })} placeholder="主角 / 反派 / 朋友 / 导师…" /></Field>
          <Field label="人物描述"><Textarea rows={4} value={next.description} onChange={(e) => setNext({ ...next, description: e.target.value })} placeholder="性格 · 背景 · 当前目标 · 与主角/其他角色的关系" /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel}>取消</Button>
            <Button size="sm" onClick={save}><Save size={12} />保存</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {characters.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-center text-[11px] text-[var(--fg-4)]">还没有角色；生成大纲后 Agent 会自动补，或你手动添加</div>
        ) : characters.map((c) => (
          <div key={c.id || c.name} className="rounded-lg border border-[var(--line)] bg-black/20 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{c.name}</span>
                {c.role ? <span className="text-[10px] uppercase tracking-wide text-[var(--fg-4)]">{c.role}</span> : null}
              </div>
              <div className="flex gap-1">
                <button type="button" aria-label="编辑" onClick={() => startEdit(c)} className="rounded p-1 text-[var(--fg-3)] hover:bg-black/30"><Feather size={12} /></button>
                <button type="button" aria-label="删除" onClick={() => remove(c.id)} className="rounded p-1 text-[var(--fg-3)] hover:bg-black/30"><Trash2 size={12} /></button>
              </div>
            </div>
            {c.description ? <p className="text-[12px] leading-relaxed text-[var(--fg-2)]">{c.description}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// —— 上下文记忆 ——
function MemoryPanel({ memory, onChange }) {
  const [open, setOpen] = useState(null);
  const [content, setContent] = useState('');

  function startAdd() {
    const name = prompt('文件名（如 设定.md / 伏笔.md / 剧情进展.md）：');
    if (!name) return;
    setOpen(name);
    setContent('');
  }
  function startEdit(name, text) { setOpen(name); setContent(text); }
  function save() {
    if (!open) return;
    const existing = memory.find((m) => m.name === open);
    const next = existing
      ? memory.map((m) => (m.name === open ? { name: open, content } : m))
      : [...memory, { name: open, content }];
    onChange(next);
    setOpen(null);
  }
  function remove(name) { onChange(memory.filter((m) => m.name !== name)); }
  function cancel() { setOpen(null); }

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium"><FolderOpen size={14} className="text-[var(--accent)]" />记忆 <Badge size="sm">{memory.length}</Badge></h3>
        <Button size="sm" variant="ghost" onClick={startAdd} disabled={open !== null}><Plus size={12} />新文件</Button>
      </div>
      {open !== null ? (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-dashed border-[var(--line)] bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wide text-[var(--fg-3)]">{open}</div>
          <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-[12px]" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel}>取消</Button>
            <Button size="sm" onClick={save}><Save size={12} />保存</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {memory.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-center text-[11px] text-[var(--fg-4)]">
            上下文记忆：设定 · 伏笔 · 剧情进展。Agent 生成完每层会自动维护，你也可以手动加。
          </div>
        ) : memory.map((m) => (
          <div key={m.name} className="group flex items-center justify-between rounded-lg border border-[var(--line)] bg-black/20 px-3 py-1.5 transition-colors hover:border-[var(--accent)]">
            <button type="button" onClick={() => startEdit(m.name, m.content)} className="flex flex-1 items-center gap-2 text-left text-[12px]">
              <FileText size={12} className="text-[var(--fg-3)]" />
              <span>{m.name}</span>
              {!m.content ? <span className="text-[10px] text-[var(--fg-4)]">（空）</span> : null}
            </button>
            <button type="button" aria-label="删除" onClick={() => remove(m.name)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 size={12} className="text-[var(--fg-3)] hover:text-red-400" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
