import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Clapperboard, GripVertical, Pencil, Play, Plus, SlidersHorizontal, Square, X } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { fileUrl } from '../lib/format.js';
import { Button, EmptyState, Field, Input, Progress, StatusPill, Textarea } from '../components/ui.jsx';
import { BusyOverlay, Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ReferencePicker from '../components/ReferencePicker.jsx';
import ChapterOps from '../components/ChapterOps.jsx';
import { useToast } from '../components/toast.jsx';

const GEN_LABEL = { empty: '无分镜', pending: '待生成', running: '生成中', done: '完成', failed: '失败' };

export default function ChaptersPage({ projectId, chapters, onRefresh, running, runningChapter, runningChapters, readOnly = false, canEdit = true, canGenerate = true, features = {}, onRun, onStop, onGoLogs }) {
  const toast = useToast();
  const [order, setOrder] = useState(chapters);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editNovel, setEditNovel] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [busy, setBusy] = useState(null);
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const [savedRefs, setSavedRefs] = useState([]);
  const [operating, setOperating] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [estimates, setEstimates] = useState(null);
  const isChapterRunning = (title) =>
    runningChapters
      ? (typeof runningChapters.has === 'function' ? runningChapters.has(title) : runningChapters.includes(title))
      : runningChapter === title;
  const allChaptersRunning = chapters.length > 0 && chapters.every((c) => isChapterRunning(c.title));

  const chapterSig = chapters.map((c) => c.title + ':' + (c.doneCount || 0) + ':' + (c.genStatus || '')).join('|');
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get('/api/projects/' + projectId + '/cost-estimate?all=1')
        .then((j) => { if (alive) setEstimates(j); })
        .catch(() => {});
    load();
    // 运行中实时刷新：完成一镜后剩余预计要立刻下降，不能等整章结束。
    const timer = running ? setInterval(load, 4000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [projectId, chapterSig, running]);

  useEffect(() => setOrder(chapters), [chapters]);

  useEffect(() => {
    api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {});
  }, []);

  const loadRefs = useCallback(() => {
    api.get('/api/projects/' + projectId + '/references').then(setSavedRefs).catch((e) => toast.error(e.message));
  }, [projectId]);

  useEffect(() => loadRefs(), [loadRefs]);

  useEffect(() => {
    if (submitting && (running || runningChapter)) setSubmitting(null);
  }, [running, runningChapter, submitting]);

  useEffect(() => {
    if (stopping && !running) setStopping(false);
  }, [running, stopping]);

  const chapterRefs = editing ? savedRefs.filter((r) => r.chapter_id === editing.id) : [];

  function openCreate() {
    setCreating(true);
    setEditTitle('');
    setEditNovel('');
    setEditDirty(false);
    setRefs([]);
  }

  function openEdit(c) {
    setEditing(c);
    setEditTitle(c.title || '');
    setEditNovel(c.novel || '');
    setEditDirty(false);
    setRefs([]);
  }

  async function saveChapter() {
    const isNew = !!creating;
    if (!isNew && !editing) return;
    setBusy(isNew ? '正在创建章节…' : '正在保存章节…');
    try {
      let cid = editing ? editing.id : null;
      if (isNew) {
        const payload = { novel: editNovel };
        if ((editTitle || '').trim()) payload.title = editTitle.trim();
        const c = await api.post('/api/projects/' + projectId + '/chapters', payload);
        cid = c.id;
      } else {
        await api.patch('/api/projects/' + projectId + '/chapters/' + cid, { title: editTitle, novel: editNovel });
      }
      if (refs.length && cid) await uploadRefs(cid);
      toast.success(isNew ? '已创建章节' : '已保存「' + editTitle + '」');
      setCreating(false);
      setEditing(null);
      setEditDirty(false);
      onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function uploadRefs(chapterId) {
    let done = 0;
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', chapterId);
      fd.append('description', it.description || '');
      try {
        await uploadForm('/api/projects/' + projectId + '/references', fd);
      } catch (e) {
        throw new Error('「' + (it.file.name || '参考图') + '」' + e.message + (done ? '；前 ' + done + ' 张已上传成功，可直接继续传剩下的' : ''));
      }
      done += 1;
      setRefs((prev) => prev.filter((x) => x.key !== it.key));
    }
    loadRefs();
    return done;
  }

  async function delRef(rid) {
    try {
      await api.del('/api/projects/' + projectId + '/references/' + rid);
      loadRefs();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function updateRef(rid, patch) {
    setSavedRefs((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
    try {
      await api.patch('/api/projects/' + projectId + '/references/' + rid, patch);
    } catch (e) {
      toast.error(e.message);
      loadRefs();
    }
  }

  async function submitRun(title) {
    setSubmitting(title);
    try {
      await onRun(title);
    } catch (e) {
      toast.error(e.message);
      setSubmitting(null);
    }
  }

  async function handleStop(chapter) {
    setStopping(true);
    try {
      await onStop(chapter);
    } catch (e) {
      toast.error(e.message);
      setStopping(false);
    }
  }

  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」及其分镜？此操作不可逆。', { danger: true }))) return;
    setBusy('正在删除章节…');
    try {
      await api.del('/api/projects/' + projectId + '/chapters/' + c.id);
      toast.success('已删除「' + c.title + '」');
      onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function persistReorder(list) {
    try {
      await api.patch('/api/projects/' + projectId + '/chapters', { ids: list.map((c) => c.id) });
      onRefresh();
    } catch (e) {
      toast.error(e.message);
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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Structure"
        title="章节管理"
        description="先规划整本书的章节骨架，再逐章生成。素材库全项目共用，分镜在「分镜审查」里查看。"
        actions={
          canEdit || canGenerate ? (
            <>
              {canEdit ? (
                <Button variant="primary" size="md" onClick={openCreate}>
                  <Plus size={14} /> 新增章节
                </Button>
              ) : null}
              {canGenerate && features.buttons?.generate !== false ? (
                <>
                  {estimates?.whole?.total > 0 ? (
                    <span className="text-[11px] text-[var(--fg-3)]">
                      预计 <b className="font-mono text-[var(--fg-2)]">{estimates.whole.total}</b> {estimates.currency}
                      {estimates.wallet?.enabled && typeof estimates.wallet.available === 'number' && estimates.wallet.available < estimates.whole.total ? (
                        <span className="ml-1 text-[var(--danger)]">（余额不足）</span>
                      ) : null}
                    </span>
                  ) : null}
                  <Button variant="secondary" size="md" disabled={!chapters.length || allChaptersRunning} onClick={() => submitRun(null)}>
                    <Play size={13} /> 生成全部章节
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      />

      {order.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {order.map((c, i) => {
            const isRunningChapter = isChapterRunning(c.title);
            const pct = c.shotCount ? Math.round((c.doneCount / c.shotCount) * 100) : 0;
            const loading = (submitting === c.title && !isRunningChapter) || (isRunningChapter && stopping);
            const est = estimates?.chapters?.find((x) => x.title === c.title || x.id === c.id);
            const estTotal = Number(est?.total) || 0;
            return (
              <article
                key={c.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overIndex !== i) setOverIndex(i);
                }}
                onDrop={() => handleDrop(i)}
                className={clsx(
                  'panel panel-hover group relative flex flex-col overflow-hidden',
                  overIndex === i && dragIndex !== null && dragIndex !== i && 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] shadow-[0_0_0_3px_rgba(232,177,92,.10)]',
                  dragIndex === i && 'opacity-60',
                )}
              >
                <div className="relative aspect-video overflow-hidden bg-black/35">
                  {c.poster ? (
                    <img src={fileUrl(projectId, c.poster)} alt={c.title} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(120%_120%_at_30%_0%,rgba(255,255,255,.05),transparent_60%)] text-[var(--fg-4)]">
                      <BookOpen size={20} />
                      <span className="font-mono text-[10px]">CHAPTER {String(i + 1).padStart(2, '0')}</span>
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_55%,rgba(0,0,0,.5))]" />

                  {canEdit ? (
                    <button
                      type="button"
                      draggable
                      title="拖拽排序"
                      aria-label="拖拽排序"
                      onDragStart={(e) => {
                        setDragIndex(i);
                        try {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', String(i));
                        } catch {
                          /* noop */
                        }
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      className="absolute left-2.5 top-2.5 cursor-grab rounded-lg border border-white/10 bg-black/50 p-1.5 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:text-white active:cursor-grabbing group-hover:opacity-100"
                    >
                      <GripVertical size={13} />
                    </button>
                  ) : null}

                  {canEdit && features.buttons?.delete !== false ? (
                    <button
                      type="button"
                      title="删除章节"
                      aria-label={'删除 ' + c.title}
                      onClick={() => removeChapter(c)}
                      className="absolute right-2.5 top-2.5 rounded-lg border border-white/10 bg-black/50 p-1.5 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:border-[color-mix(in_srgb,var(--danger)_45%,transparent)] hover:text-[var(--danger)] group-hover:opacity-100"
                    >
                      <X size={13} />
                    </button>
                  ) : null}

                  <div className="absolute bottom-2.5 left-2.5">
                    <StatusPill status={c.genStatus === 'running' ? 'running' : c.genStatus === 'done' ? 'done' : c.genStatus === 'failed' ? 'failed' : 'pending'}>
                      {GEN_LABEL[c.genStatus] || c.status}
                    </StatusPill>
                  </div>
                </div>

                <div className="flex flex-col gap-2.5 p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="m-0 font-mono text-[9.5px] tracking-[.14em] text-[var(--fg-4)]">CHAPTER {String(i + 1).padStart(2, '0')}</p>
                      <h3 className="m-0 mt-0.5 truncate text-[14px] font-medium text-[var(--fg)]" title={c.title}>
                        {c.title}
                      </h3>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Progress value={pct} tone={c.genStatus === 'done' ? 'success' : c.genStatus === 'failed' ? 'danger' : 'accent'} height={3} />
                    <div className="flex items-center justify-between text-[10.5px] text-[var(--fg-4)]">
                      <span className="inline-flex items-center gap-1">
                        <Clapperboard size={10} className="opacity-70" />
                        {c.shotCount ? c.doneCount + ' / ' + c.shotCount + ' 镜' : '暂无分镜'}
                      </span>
                      <span>{isRunningChapter ? '正在生成' : pct ? pct + '%' : ''}</span>
                    </div>
                  </div>

                  {estTotal > 0 ? (
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="text-[var(--fg-4)]">剩余预计{running ? '（含正在渲染）' : ''}</span>
                      <span className="font-mono text-[var(--fg-2)]">
                        {estTotal} {est.currency || estimates.currency}
                        {estimates.wallet?.enabled && typeof estimates.wallet.available === 'number' && estimates.wallet.available < estTotal ? (
                          <span className="ml-1 text-[var(--danger)]">余额不足</span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}

                  {canEdit || canGenerate ? (
                    <div className="flex items-center gap-1.5 pt-0.5">
                      {canGenerate && features.buttons?.generate !== false ? (
                        isRunningChapter ? (
                          <Button variant="danger" size="sm" className="flex-1" loading={stopping} onClick={() => handleStop(c.title)}>
                            <Square size={12} /> 停止
                          </Button>
                        ) : (
                          <Button
                            variant="primary"
                            size="sm"
                            className="flex-1"
                            loading={loading}
                            disabled={isRunningChapter || loading}
                            onClick={() => submitRun(c.title)}
                          >
                            <Play size={12} /> 生成
                          </Button>
                        )
                      ) : null}
                      {canEdit ? (
                        <>
                          <Button variant="secondary" size="iconSm" title="编辑章节" aria-label="编辑章节" onClick={() => openEdit(c)}>
                            <Pencil size={13} />
                          </Button>
                          <Button variant="secondary" size="iconSm" title="生成操作" aria-label="生成操作" onClick={() => setOperating(c)}>
                            <SlidersHorizontal size={13} />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={BookOpen}
            title="还没有章节"
            description="新增章节并粘贴本章小说原文；标题留空会自动命名为「第 N 章」。"
            action={
              canEdit ? (
                <Button variant="primary" size="md" onClick={openCreate}>
                  <Plus size={14} /> 新增章节
                </Button>
              ) : null
            }
          />
        </div>
      )}

      <Modal
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={creating ? '新建章节' : '编辑章节'}
        description={creating ? '标题可留空，自动命名为「第 N 章」；建议同时粘贴本章原文。' : editing ? editing.title : ''}
        size="xl"
        footer={
          <>
            <Button variant="ghost" size="md" disabled={!!busy} onClick={() => { setCreating(false); setEditing(null); }}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={!!busy}
              disabled={creating ? false : !editDirty && !refs.length}
              onClick={saveChapter}
            >
              保存本章
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="章节标题">
            <Input value={editTitle} onChange={(e) => { setEditTitle(e.target.value); setEditDirty(true); }} placeholder={creating ? '留空自动命名为「第 N 章」' : '章节标题'} />
          </Field>
          <Field label="本章小说原文" hint={editNovel ? editNovel.length.toLocaleString() + ' 字' : undefined}>
            <Textarea
              rows={9}
              value={editNovel}
              onChange={(e) => { setEditNovel(e.target.value); setEditDirty(true); }}
              placeholder="粘贴或编辑本章原文…"
              className="min-h-[170px]"
            />
          </Field>
          <p className="m-0 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
            内容规范：禁止露骨色情/裸露、血腥暴力、政治敏感、武器/恐怖教学与宗教极端内容；提交时服务端会审核。
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-medium text-[var(--fg-2)]">参考图片素材</span>
            <ReferencePicker
              projectId={projectId}
              items={refs}
              onChange={setRefs}
              saved={chapterRefs}
              onUpdateSaved={updateRef}
              onDeleteSaved={delRef}
              allowAdd={vision}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={!!operating}
        onOpenChange={(o) => !o && setOperating(null)}
        title={'生成操作' + (operating ? ' · ' + operating.title : '')}
        description="整章重跑、分阶段运行与重新拆分分镜都在这里。"
        size="lg"
      >
        {operating ? (
          <ChapterOps
            projectId={projectId}
            chapter={operating}
            running={isChapterRunning(operating.title)}
            runningChapter={isChapterRunning(operating.title) ? operating.title : null}
            onRun={onRun}
            onStop={() => onStop(operating.title)}
            onRefresh={onRefresh}
            onGoLogs={() => {
              setOperating(null);
              onGoLogs && onGoLogs();
            }}
          />
        ) : null}
      </Modal>

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}
