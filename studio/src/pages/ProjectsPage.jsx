import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowUpRight, Clapperboard, Film, Image as ImageIcon, Layers, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { fileUrl, fmtRelative, STATUS_TEXT } from '../lib/format.js';
import {
  STYLE_OPTIONS,
  STYLE_CUSTOM,
  resolveStyle,
  VIDEO_RESOLUTION_CUSTOM,
  PROJECT_TYPES,
  PROJECT_TYPE_LABEL,
} from '../lib/shared.js';
import { RESOLUTION_SELECT_ITEMS, RATIO_SELECT_ITEMS, MetaItem } from '../components/visuals.jsx';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton, StatusPill, Switch, Textarea } from '../components/ui.jsx';
import { Drawer, FormSection } from '../components/overlays.jsx';
import ReferencePicker from '../components/ReferencePicker.jsx';
import { useToast } from '../components/toast.jsx';

const PAGE_SIZE = 10;
const QUEUE_KIND_LABEL = {
  t2i: '资产图', i2i: '资产图', image: '资产图',
  r2v: '分镜视频', i2v: '分镜视频', video: '分镜视频',
  tts: '音色', voice: '音色', music: '背景音乐', export: '合成/导出',
};

export default function ProjectsPage({ onOpen, type = '', showTypeFilter = false, showCreate = true, publicMode = false, features = {} }) {
  const toast = useToast();
  const [typeFilter, setTypeFilter] = useState('');
  const typeParam = showTypeFilter ? typeFilter : type;
  const [projects, setProjects] = useState([]);
  const [meta, setMeta] = useState({ total: 0 });
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const sentinelRef = useRef(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [vision, setVision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState(null);

  const [form, setForm] = useState({ name: '', novel: '', scriptMode: 'auto', script: '', style: '', customStyle: '', res: '480P', ratio: '16:9', cw: '', ch: '', enableBgm: true });
  const [refs, setRefs] = useState([]);

  const query = (page) =>
    '/api/projects?page=' + page + '&pageSize=' + PAGE_SIZE + (typeParam ? '&type=' + encodeURIComponent(typeParam) : '');

  const load = useCallback(() => {
    setLoading(true);
    pageRef.current = 1;
    return api
      .get(query(1))
      .then((r) => {
        setProjects(r.items || []);
        setMeta({ total: r.total || 0 });
        setHasMore(!!r.hasMore);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [typeParam]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const next = pageRef.current + 1;
    return api
      .get(query(next))
      .then((r) => {
        pageRef.current = next;
        setProjects((prev) => [...prev, ...(r.items || [])]);
        setHasMore(!!r.hasMore);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, typeParam]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {});
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const running = projects.filter((p) => p.status === 'running').length;
  const assets = projects.reduce((n, p) => n + (p.assetCount || 0), 0);
  const shots = projects.reduce((n, p) => n + (p.shotCount || 0), 0);

  function openCreate() {
    if (features.createProject === false) return;
    setCreateOpen(true);
  }

  async function create() {
    if (!form.name.trim() || !form.novel.trim()) return;
    if (form.scriptMode === 'own' && !form.script.trim()) return;
    setBusy(true);
    try {
      const p = await api.post('/api/projects', {
        name: form.name.trim(),
        novel: form.novel,
        auto_script: form.scriptMode === 'auto',
        script: form.scriptMode === 'own' ? form.script : '',
        style: resolveStyle(form.style, form.customStyle),
        video_resolution: form.res,
        video_aspect_ratio: form.ratio,
        video_width: Number(form.cw) || 0,
        video_height: Number(form.ch) || 0,
        enable_bgm: form.enableBgm,
      });
      load();
      // 项目已落库：参考图上传失败不能让用户以为创建失败，先提示再照样进入项目
      try {
        if (refs.length) {
          const chapters = await api.get('/api/projects/' + p.id + '/chapters');
          const chapterId = (chapters[0] && chapters[0].id) || '';
          for (const it of refs) {
            const fd = new FormData();
            fd.append('file', it.file);
            fd.append('mode', it.mode);
            fd.append('category', it.category || 'other');
            fd.append('chapter_id', chapterId);
            fd.append('description', it.description || '');
            await uploadForm('/api/projects/' + p.id + '/references', fd);
          }
        }
      } catch (e) {
        toast.error('项目已创建，但参考图上传失败：' + e.message + '（可在章节页重新上传）');
      }
      setCreateOpen(false);
      resetForm();
      onOpen(p.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    setForm({ name: '', novel: '', scriptMode: 'auto', script: '', style: '', customStyle: '', res: '480P', ratio: '16:9', cw: '', ch: '', enableBgm: true });
    setRefs([]);
  }

  async function del(p) {
    if (!(await toast.confirm('删除「' + p.name + '」及其所有素材与成片？此操作不可逆。', { danger: true }))) return;
    try {
      await api.del('/api/projects/' + p.id);
      toast.success('已删除');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const canCreate = !!form.name.trim() && !!form.novel.trim() && (form.scriptMode === 'auto' || !!form.script.trim());

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.get('/api/activity')
        .then((a) => { if (alive) setActivity(a); })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const queueLabel = (q) => q?.subject || QUEUE_KIND_LABEL[q?.kind] || q?.kind || '渲染任务';

  return (
    <div className="flex animate-fade-up flex-col gap-7">
      <section className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1 className="display-title mt-2">{type === 'agent' ? 'Agent无限创作' : '作品集'}</h1>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--fg-3)]">
            {type === 'agent'
              ? '一段小说交给 Agent，拆章节、建素材、写分镜、出视频。所有项目与经典界面共用同一份数据。'
              : '按创作类型归档全部项目，点击非 Agent 项目会直接进入对应工作台。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showTypeFilter ? (
            <Select
              className="w-40"
              value={typeFilter}
              onChange={setTypeFilter}
              items={[{ value: '', label: '全部分类' }, ...PROJECT_TYPES.map((t) => ({ value: t, label: PROJECT_TYPE_LABEL[t] || t }))]}
            />
          ) : null}
          {showCreate && features.createProject !== false ? (
            <Button variant="primary" size="md" onClick={openCreate}>
              <Plus size={15} />
              新建项目
            </Button>
          ) : null}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={Layers} label="项目总数" value={meta.total} />
        <Stat icon={Sparkles} label="本页运行中" value={running} tone={running ? 'accent' : undefined} />
        <Stat icon={ImageIcon} label="本页资产" value={assets} />
        <Stat icon={Film} label="本页分镜" value={shots} />
      </section>

      {activity?.jobs?.length ? (
        <section className="panel flex flex-col gap-2 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-2)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse-soft" />
              当前执行
            </span>
            <span className="text-[10.5px] text-[var(--fg-4)]">
              {activity.jobs.length} 个任务 · {activity.queue?.running || 0} 个渲染中
              {activity.queue?.waiting ? ' · ' + activity.queue.waiting + ' 个排队' : ''}
              {activity.agent?.limit > 0 ? ' · Agent ' + activity.agent.active + '/' + activity.agent.limit : ''}
              {activity.agent?.limit > 0 && activity.agent.waiting ? '（' + activity.agent.waiting + ' 等待）' : ''}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {activity.jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => onOpen({ id: j.projectId })}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-[var(--fg-3)]">
                  <span className="shrink-0 font-medium text-[var(--fg-2)]">{j.projectName || j.projectId.slice(0, 8)}</span>
                  <span className="shrink-0 text-[var(--fg-4)]">·</span>
                  <span className="shrink-0">{j.chapter || '全部章节'}</span>
                  <span className="shrink-0 text-[var(--fg-4)]">·</span>
                  <span className="truncate">
                    {j.queue ? (QUEUE_KIND_LABEL[j.queue.kind] || j.queue.kind || '渲染') + ' · 正在渲染 ' + queueLabel(j.queue) : (j.phase || '准备中')}
                  </span>
                </span>
                <ArrowUpRight size={12} className="shrink-0 text-[var(--fg-4)]" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-[13px] font-semibold text-[var(--fg-2)]">最近项目</h2>
          <span className="text-[11px] text-[var(--fg-4)]">已加载 {projects.length} / {meta.total || '—'}</span>
        </div>

        {loading ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="panel overflow-hidden">
                <Skeleton className="aspect-video rounded-none" />
                <div className="flex flex-col gap-2 p-3.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
            {projects.map((p) => (
              <article key={p.id} className="panel panel-hover group relative overflow-hidden">
                <button type="button" onClick={() => onOpen(p)} className="block w-full text-left">
                  <div className="media-hover relative aspect-video overflow-hidden bg-black/40">
                    {p.poster ? (
                      <img src={fileUrl(p.id, p.poster)} alt={p.name} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(120%_120%_at_30%_0%,rgba(255,255,255,.05),transparent_60%)] text-[var(--fg-4)]">
                        <Clapperboard size={22} />
                        <span className="text-[10.5px]">尚无预览</span>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,.25)_0%,transparent_35%,rgba(0,0,0,.55)_100%)] opacity-80" />
                    <div className="absolute left-3 top-3">
                      <StatusPill status={p.status}>{STATUS_TEXT[p.status] || p.status || '空闲'}</StatusPill>
                    </div>
                    <span className="absolute bottom-3 right-3 flex translate-y-1 items-center gap-1 rounded-lg border border-white/10 bg-black/45 px-2 py-1 text-[10.5px] text-white/85 opacity-0 backdrop-blur transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                      打开项目 <ArrowUpRight size={11} />
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 p-3.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-[var(--fg)]">{p.name}</span>
                      {showTypeFilter ? (
                        <Badge className="shrink-0">{PROJECT_TYPE_LABEL[p.type] || p.type || 'Agent无限创作'}</Badge>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2.5 text-[11.5px] text-[var(--fg-3)]">
                        <MetaItem icon={Layers}>{p.assetCount ?? 0}</MetaItem>
                        <MetaItem icon={Clapperboard}>{p.shotCount ?? 0}</MetaItem>
                      </span>
                      <span className="shrink-0 text-[11px] text-[var(--fg-4)]">{fmtRelative(p.updatedAt)}</span>
                    </div>
                  </div>
                </button>
                {features.buttons?.delete !== false ? (
                  <button
                    type="button"
                    aria-label={'删除项目 ' + p.name}
                    onClick={() => del(p)}
                    className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:border-[color-mix(in_srgb,var(--danger)_45%,transparent)] hover:text-[var(--danger)] group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="panel">
            <EmptyState
              icon={Clapperboard}
              title="还没有项目"
              description={type === 'agent' ? '粘贴一段小说或一句话描述故事，Agent 会从章节骨架开始，一路做到成片。' : '这里会汇总全部类型的项目；现在还没有任何项目。'}
              action={
                showCreate && features.createProject !== false ? (
                  <Button variant="primary" size="md" onClick={openCreate}>
                    <Plus size={15} /> 新建第一个项目
                  </Button>
                ) : null
              }
            />
          </div>
        )}

        <div ref={sentinelRef} className="flex items-center justify-center gap-2 py-2 text-[11px] text-[var(--fg-4)]">
          {loadingMore ? <Skeleton className="h-3 w-24" /> : hasMore ? '向下滚动加载更多' : projects.length > 0 ? '已经到底了' : ''}
        </div>
      </section>

      <Drawer
        open={createOpen}
        onOpenChange={(o) => !busy && setCreateOpen(o)}
        title="新建项目"
        description="故事原文决定后续所有章节与分镜，尽量粘贴完整、连贯的文本。"
        width={640}
        scrollHint="下面还有参数"
        footer={
          <>
            <span className="mr-auto text-[11px] text-[var(--fg-4)]">{form.novel.length.toLocaleString()} 字</span>
            <Button variant="ghost" size="md" disabled={busy} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={busy} disabled={!canCreate || busy} onClick={create}>
              <Sparkles size={14} />
              创建并打开
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-7">
          <FormSection index="01" title="故事">
            <Field label="项目名" required>
              <Input
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：长夜将尽"
              />
            </Field>
            <Field label="小说原文 / 故事描述" required hint="支持整本小说或一段梗概；后续可在章节管理里按章编辑。">
              <Textarea
                rows={10}
                value={form.novel}
                onChange={(e) => setForm({ ...form, novel: e.target.value })}
                placeholder="粘贴小说原文，或写一句话描述你想拍的故事…"
                className="min-h-[190px]"
              />
            </Field>
            <Field
              label="剧本"
              hint={form.scriptMode === 'auto'
                ? 'Agent 会先从小说写剧本，再按剧本拆分镜；创建后也可在章节「剧本」里修改。'
                : '多章请用「第N章」标题分隔，并与小说章节一一对应；单章可直接粘贴整段剧本。'}
            >
              <div className="flex flex-wrap gap-1.5">
                <StyleChip active={form.scriptMode === 'auto'} onClick={() => setForm({ ...form, scriptMode: 'auto' })}>
                  自动生成剧本
                </StyleChip>
                <StyleChip active={form.scriptMode === 'own'} onClick={() => setForm({ ...form, scriptMode: 'own' })}>
                  我已有剧本
                </StyleChip>
              </div>
            </Field>
            {form.scriptMode === 'own' ? (
              <Field label="剧本内容" required hint={form.script ? form.script.length.toLocaleString() + ' 字' : undefined}>
                <Textarea
                  rows={8}
                  value={form.script}
                  onChange={(e) => setForm({ ...form, script: e.target.value })}
                  placeholder="粘贴现成剧本…"
                  className="min-h-[150px]"
                />
              </Field>
            ) : null}
            <p className="m-0 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
            </p>
          </FormSection>

          <div className="hairline" />

          <FormSection index="02" title="画面风格" description="可留空，由 Agent 根据故事推断">
            <div className="flex flex-wrap gap-1.5">
              <StyleChip active={form.style === ''} onClick={() => setForm({ ...form, style: '' })}>
                不指定
              </StyleChip>
              {STYLE_OPTIONS.map((s) => (
                <StyleChip key={s} active={form.style === s} onClick={() => setForm({ ...form, style: s })}>
                  {s}
                </StyleChip>
              ))}
            </div>
            {form.style === STYLE_CUSTOM ? (
              <Input
                value={form.customStyle}
                onChange={(e) => setForm({ ...form, customStyle: e.target.value })}
                placeholder="描述自定义风格，例如：水墨写意、低饱和胶片颗粒"
              />
            ) : null}
          </FormSection>

          <div className="hairline" />

          <FormSection index="03" title="视频参数" description="项目内所有分镜默认继承，可随时在项目设置里修改">
            <div className="grid grid-cols-2 gap-3">
              <Field label="分辨率">
                <Select
                  value={form.res}
                  onChange={(v) => setForm({ ...form, res: v })}
                  items={RESOLUTION_SELECT_ITEMS}
                />
              </Field>
              <Field label="宽高比">
                <Select value={form.ratio} onChange={(v) => setForm({ ...form, ratio: v })} items={RATIO_SELECT_ITEMS} />
              </Field>
            </div>
            {form.res === VIDEO_RESOLUTION_CUSTOM ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="宽度（px）">
                  <Input type="number" min="64" step="32" value={form.cw} onChange={(e) => setForm({ ...form, cw: e.target.value })} placeholder="1024" />
                </Field>
                <Field label="高度（px）">
                  <Input type="number" min="64" step="32" value={form.ch} onChange={(e) => setForm({ ...form, ch: e.target.value })} placeholder="576" />
                </Field>
              </div>
            ) : null}
            <Switch
              checked={form.enableBgm}
              onChange={(v) => setForm({ ...form, enableBgm: v })}
              label="自动生成背景音乐"
              hint="视频阶段生成纯音乐并合成到成片；也可以之后在「背景音乐」页手动处理。"
            />
          </FormSection>

          {vision ? (
            <>
              <div className="hairline" />
              <FormSection index="04" title="参考图片" description="可先跳过，进入项目后再补">
                <ReferencePicker projectId="" items={refs} onChange={setRefs} allowAdd />
              </FormSection>
            </>
          ) : null}
        </div>
      </Drawer>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }) {
  return (
    <div className="panel flex items-center gap-3 px-3.5 py-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
        <Icon size={14} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-[17px] leading-tight tracking-tight" style={{ color: tone === 'accent' ? 'var(--accent)' : 'var(--fg)' }}>
          {value}
        </span>
        <span className="truncate text-[10.5px] text-[var(--fg-3)]">{label}</span>
      </div>
    </div>
  );
}

function StyleChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-full border px-3 py-1.5 text-[12px] transition-all duration-150',
        active
          ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
          : 'border-[var(--line)] bg-white/[0.02] text-[var(--fg-3)] hover:border-[var(--line-strong)] hover:text-[var(--fg-2)]',
      )}
    >
      {children}
    </button>
  );
}
