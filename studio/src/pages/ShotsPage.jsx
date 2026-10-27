import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Clapperboard, Clock, Download, Film, Hash, Package, Play, Plus, RefreshCw, Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useBilling, costLabel, costText } from '../lib/billing.js';
import CostButton from '../components/CostButton.jsx';
import { fileUrl, STATUS_TEXT, withSession } from '../lib/format.js';
import { asArray, dialogueSpeakers, nameMatches, ASSET_CATEGORY_LABEL } from '../lib/shared.js';
import { RatioMeta, ResolutionMeta } from '../components/visuals.jsx';
import { AssetCategoryIcon } from '../components/visuals.jsx';
import { Badge, Button, EmptyState, Input, Select, Spinner, StatusPill } from '../components/ui.jsx';
import { BusyOverlay, Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import MaterialPicker from '../components/MaterialPicker.jsx';
import { ImageLightbox } from '../components/media.jsx';
import { useToast } from '../components/toast.jsx';

const MATERIAL_FIELD = { character: 'character_ids', scene: 'scene_ids', prop: 'prop_ids', costume: 'costume_ids', age: 'age_ids', audio: 'audio_ids' };

export default function ShotsPage({ projectId, chapters = [], cursorId, onCursorChange, running = false, jobs = [], onRefresh, readOnly = false, canEdit = true, canGenerate = true, canExport = true, features = {} }) {
  const toast = useToast();
  const [shots, setShots] = useState([]);
  const [assets, setAssets] = useState([]);
  const [project, setProject] = useState(null);
  const [preview, setPreview] = useState(null);
  const [feedback, setFeedback] = useState({});
  const [zipping, setZipping] = useState(false);
  const [ask, setAsk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [materialPicker, setMaterialPicker] = useState(null);
  const [busy, setBusy] = useState(null);
  // 单镜提交中：只锁这一镜的按钮，不拉全屏遮罩（否则点一下整个页面像卡死）
  const [submitting, setSubmitting] = useState('');
  // 提交锁：防止同一镜在 React 重渲染前被连点两次（状态更新是异步的，disabled 来不及生效）
  const submitLockRef = useRef(new Set());
  // 提交成功后先把任务记在本地：等父级任务列表刷新的空窗期内，按钮保持禁用，避免二次扣费
  const [localJobs, setLocalJobs] = useState({});
  const billing = useBilling();

  const load = useCallback(() => {
    return Promise.all([
      api.get('/api/projects/' + projectId + '/shots').then(setShots).catch((e) => toast.error(e.message)),
      api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch((e) => toast.error(e.message)),
      api.get('/api/projects/' + projectId).then(setProject).catch(() => {}),
    ]);
  }, [projectId]);

  // 轮询只拉分镜：素材/项目在生成期间基本不变，每 3 秒全量重拉会让整页（含其他视频）跟着重渲染。
  // 数据没变时直接返回旧数组（引用不变），React 就不会重渲染整张分镜表。
  const loadShots = useCallback(
    () =>
      api
        .get('/api/projects/' + projectId + '/shots')
        .then((list) => setShots((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list)))
        .catch(() => {}),
    [projectId],
  );

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(loadShots, 3000);
    return () => clearInterval(t);
  }, [running, loadShots]);

  const chapterTitle = chapters.find((c) => c.id === cursorId)?.title || '';
  const shown = chapterTitle ? shots.filter((s) => (s.chapter || '默认') === chapterTitle) : shots;
  const doneShots = shown.filter((s) => s.video_path && s.status === 'done');
  // 单分镜多候选：后端返回 videos 列表；老数据只有 video_path，做一条兼容候选。
  const candidatesOf = (s) => (Array.isArray(s.videos) && s.videos.length
    ? s.videos
    : (s.video_path ? [{ id: '__legacy__', video_path: s.video_path, selected: true, idx: 0, seed: s.seed }] : []));
  const selectedOf = (s) => {
    const cs = candidatesOf(s);
    return cs.find((v) => v.selected) || cs[0] || null;
  };
  const isActiveJob = (j) => j && (j.status === 'running' || j.status === 'queued');
  const chapterJobFor = (shot) =>
    jobs.find(
      (j) =>
        isActiveJob(j)
        && ((j.checkpoint?.chapter && j.checkpoint.chapter === shot.chapter)
          || (!j.checkpoint?.chapter && (j.type === 'create' || j.type === 'stage'))),
    );
  const activeChapterJob = jobs.find(
    (j) =>
      isActiveJob(j)
      && ((chapterTitle && j.checkpoint?.chapter === chapterTitle)
        || (!j.checkpoint?.chapter && (j.type === 'create' || j.type === 'stage'))),
  );

  const byId = (id) => assets.find((a) => a.id === id);
  const activeJobFor = (subject) => {
    const real = jobs.find(
      (j) => (j.status === 'running' || j.status === 'queued') && j.checkpoint && j.checkpoint.subject === subject,
    );
    if (real) return real;
    const local = localJobs[subject];
    if (local && Date.now() - local.at < 5 * 60_000) return local.job;
    return undefined;
  };

  // 父级任务列表一旦出现同一个任务，就清掉本地占位；超过 5 分钟也清，避免误锁
  useEffect(() => {
    setLocalJobs((prev) => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const ids = new Set(jobs.map((j) => j.id));
      let changed = false;
      const next = { ...prev };
      for (const sid of keys) {
        const e = prev[sid];
        if (ids.has(e.job.id) || Date.now() - e.at > 5 * 60_000) {
          delete next[sid];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [jobs]);
  const charsOf = (s) => asArray(s.character_ids).map(byId).filter(Boolean);
  const scenesOf = (s) => asArray(s.scene_ids).map(byId).filter(Boolean);
  const propsOf = (s) => asArray(s.prop_ids).map(byId).filter(Boolean);
  const costumesOf = (s) => asArray(s.costume_ids).map(byId).filter(Boolean);
  const agesOf = (s) => asArray(s.age_ids).map(byId).filter(Boolean);
  const audiosOf = (s) => asArray(s.audio_ids).map(byId).filter(Boolean);

  async function regen(shotId, render = true, append = false) {
    if (submitting) return;
    if (submitLockRef.current.has(shotId)) return;
    submitLockRef.current.add(shotId);
    const fb = (feedback[shotId] || '').trim();
    setSubmitting(shotId);
    try {
      const job = await api.post('/api/projects/' + projectId + '/shots/' + shotId + '/regenerate', { feedback: fb || undefined, render, append });
      if (job && job.id) setLocalJobs((prev) => ({ ...prev, [shotId]: { job, at: Date.now() } }));
      toast.success(append ? '已提交生成候选' : (render ? '已提交重生成' : '已提交：仅 LLM 改写提示词，不渲染视频'));
      if (fb) setFeedback((f) => ({ ...f, [shotId]: '' }));
      // 乐观更新这一镜的状态即可；任务列表/项目状态由 WebSocket 与后台轮询自然更新，
      // 这里不再主动触发父级全量刷新（每次点击会多出 3 个请求 + 整页重渲染）。
      setShots((list) =>
        list.map((x) => (x.id === shotId ? { ...x, status: render ? 'generating' : x.status, error: '' } : x)),
      );
      // 兜底对账：任务若秒失败（例如缺参考图），running 可能还没变 true 轮询就结束了，
      // 这里 2 秒后单独拉一次分镜，把乐观状态纠正为真实结果
      setTimeout(loadShots, 2000);
    } catch (e) {
      setShots((list) => list.map((x) => (x.id === shotId && x.status === 'generating' ? { ...x, status: 'pending' } : x)));
      toast.error(e.message);
    } finally {
      submitLockRef.current.delete(shotId);
      setSubmitting('');
    }
  }

  function onRegen(shotId) {
    if ((feedback[shotId] || '').trim()) setAsk(shotId);
    else regen(shotId, true);
  }

  // 勾选一条候选作为「导出用」：后端会同步 shots.video_path，导出/打包无需改链路。
  async function selectVideo(shotId, videoId) {
    if (!videoId || videoId === '__legacy__') return;
    try {
      const videos = await api.post('/api/projects/' + projectId + '/shots/' + shotId + '/videos/' + videoId + '/select');
      const selected = videos.find((v) => v.selected) || videos[0] || null;
      setShots((list) => list.map((x) => (x.id === shotId ? { ...x, videos, video_path: selected?.video_path || x.video_path } : x)));
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function exportChapter() {
    setBusy('正在导出本章成片…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/export', { chapter: chapterTitle });
      const url = fileUrl(projectId, r.export_path);
      const a = document.createElement('a');
      a.href = url;
      a.download = (r.export_path || '').split('/').pop() || 'chapter.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('导出成功，已开始下载。成片可到「成片」页预览和下载。');
      onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function zipShots() {
    setZipping(true);
    setBusy('正在打包视频片段…');
    try {
      const url = withSession('/api/projects/' + projectId + '/shots/zip' + (chapterTitle ? '?chapter=' + encodeURIComponent(chapterTitle) : ''));
      const res = await fetch(url);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'HTTP ' + res.status);
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
    } catch (e) {
      toast.error('打包失败：' + e.message);
    } finally {
      setZipping(false);
      setBusy(null);
    }
  }

  function openMaterial(shotId, category, mode, replaceAssetId) {
    setMaterialPicker({ shotId, category, mode, replaceAssetId });
  }

  async function applyMaterial(assetId) {
    const p = materialPicker;
    if (!p) return;
    const shot = shots.find((s) => s.id === p.shotId);
    const field = MATERIAL_FIELD[p.category];
    if (!shot || !field) return;
    const cur = asArray(shot[field]);
    let next;
    if (p.mode === 'replace' && p.replaceAssetId) next = cur.map((id) => (id === p.replaceAssetId ? assetId : id));
    else next = cur.includes(assetId) ? cur : [...cur, assetId];
    setMaterialPicker(null);
    setBusy('正在更新素材…');
    try {
      await api.patch('/api/projects/' + projectId + '/shots/' + p.shotId, { [field]: next });
      toast.success('素材已更新');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function removeMaterial(shotId, category, assetId) {
    const shot = shots.find((s) => s.id === shotId);
    const field = MATERIAL_FIELD[category];
    if (!shot || !field) return;
    const next = asArray(shot[field]).filter((id) => id !== assetId);
    setBusy('正在移除素材…');
    try {
      await api.patch('/api/projects/' + projectId + '/shots/' + shotId, { [field]: next });
      toast.success('素材已移除');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Review"
        title="分镜审查"
        description="逐镜检查画面、台词与参考素材；确认无误后再生成视频，避免返工。"
        actions={
          canGenerate || canExport ? (
            <>
              {canExport && features.buttons?.export !== false ? (
                <CostButton
                  variant="primary"
                  size="md"
                  disabled={!shown.length}
                  onClick={exportChapter}
                  cost={costLabel(billing, 'exportPerChapter', 1)}
                >
                  <Download size={13} /> 导出本章成片
                </CostButton>
              ) : null}
              {canExport && features.buttons?.export !== false ? (
                <Button variant="secondary" size="md" disabled={!doneShots.length || zipping} onClick={zipShots}>
                  <Package size={13} /> {zipping ? '打包中…' : '打包片段'}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="panel flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span className="text-[11px] text-[var(--fg-3)]">章节</span>
        <Select
          value={cursorId}
          onChange={(v) => onCursorChange(v)}
          items={chapters.map((c) => ({ value: c.id, label: c.title }))}
          placeholder="选择章节"
          className="w-[220px]"
          size="sm"
        />
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
          <Badge tone="neutral">共 {shown.length} 镜</Badge>
          <Badge tone={doneShots.length ? 'success' : 'neutral'}>完成 {doneShots.length}</Badge>
          {running ? (
            <Badge tone="accent" dot>
              {activeChapterJob ? '生成中 · ' + (activeChapterJob.phase || '准备中') : '生成中'}
            </Badge>
          ) : null}
        </span>
      </div>

      {activeChapterJob ? (
        <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] px-3 py-2 text-[11px] leading-relaxed text-[var(--fg-3)]">
          本章任务运行中：<b className="text-[var(--fg-2)]">{activeChapterJob.phase || '准备中'}</b>。
          分镜视频会随任务自动推进；运行期间单镜生成/改写按钮已锁定，避免同一镜重复提交。
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="panel p-4">
              <div className="skeleton h-4 w-40 rounded" />
              <div className="mt-3 grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
                <div className="skeleton aspect-video rounded-xl" />
                <div className="flex flex-col gap-2">
                  <div className="skeleton h-3 w-2/3 rounded" />
                  <div className="skeleton h-3 w-1/2 rounded" />
                  <div className="skeleton h-3 w-3/5 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : shown.length ? (
        <div className="flex flex-col gap-3">
          {shown.map((s) => {
            const chars = charsOf(s);
            const scenes = scenesOf(s);
            const props = propsOf(s);
            const costumes = costumesOf(s);
            const ages = agesOf(s);
            const audios = audiosOf(s);
            const speakers = dialogueSpeakers(s.dialogue);
            const speakingChars = chars.filter((c) => speakers.some((sp) => nameMatches(sp, c.name)));
            const voices = speakingChars.filter((c) => c.voice_ref).map((c) => ({ name: c.name, voice_ref: c.voice_ref }));
            const job = activeJobFor(s.id);
            const chapterJob = chapterJobFor(s);
            const shotBlocked = !!job || !!chapterJob;
            const candidates = candidatesOf(s);
            const selected = selectedOf(s);
            return (
              <article
                key={s.id}
                className="panel relative overflow-hidden"
                // 参考图很多（每镜 10+ 张）时，整页一次性布局/绘制会卡；
                // 让浏览器跳过屏幕外卡片的渲染，滚动到附近再算。
                style={{ contentVisibility: 'auto', containIntrinsicSize: '520px' }}
              >
                {submitting === s.id ? (
                  <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
                    <span className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/70 px-3 py-1.5 text-[11px] text-white/90">
                      <Spinner size={12} /> 提交中…
                    </span>
                  </div>
                ) : null}
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-7 min-w-[34px] items-center justify-center rounded-md border border-[var(--line)] bg-white/[0.03] px-1.5 font-mono text-[10.5px] text-[var(--fg-3)]">
                      #{String(s.idx).padStart(2, '0')}
                    </span>
                    <h3 className="m-0 truncate text-[13.5px] font-medium text-[var(--fg)]">{s.scene_name || '未命名镜头'}</h3>
                    <StatusPill status={s.status}>{STATUS_TEXT[s.status] || s.status}</StatusPill>
                    {s.chapter ? <Badge tone="neutral">{s.chapter}</Badge> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[var(--fg-4)]">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} className="opacity-70" />
                      {s.duration}s
                    </span>
                    <ResolutionMeta resolution={s.resolution} width={project?.video_width} height={project?.video_height} />
                    <RatioMeta ratio={s.aspect_ratio || '16:9'} />
                    {s.seed ? (
                      <span className="inline-flex items-center gap-1">
                        <Hash size={11} className="opacity-70" />
                        {s.seed}
                      </span>
                    ) : null}
                  </div>
                </header>

                <div className="grid gap-4 p-4 lg:grid-cols-[340px_minmax(0,1fr)]">
                  <div className="flex flex-col gap-2">
                    <div className="media-frame aspect-video">
                      {selected?.video_path || s.video_path ? (
                        <video className="h-full w-full object-cover" src={fileUrl(projectId, selected?.video_path || s.video_path)} controls preload="metadata" />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2.5 text-[var(--fg-4)]">
                          <Film size={22} />
                          <span className="text-[10.5px]">
                            {job
                              ? (job.status === 'queued' ? '排队中…' : '正在生成视频…')
                              : chapterJob
                                ? '本章生成中（' + (chapterJob.phase || '准备中') + '），本镜视频尚未开始'
                                : s.status === 'generating'
                                  ? '上次生成已中断'
                                  : '尚未生成视频'}
                          </span>
                          {canGenerate && features.buttons?.generate !== false && !shotBlocked ? (
                            <CostButton
                              variant="secondary"
                              size="sm"
                              disabled={submitting === s.id}
                              cost={submitting === s.id ? '' : costText(billing, 'videoPerSecond', s.duration)}
                              onClick={() => onRegen(s.id)}
                            >
                              <Play size={12} /> {submitting === s.id ? '提交中…' : s.status === 'generating' ? '继续生成' : '生成此镜'}
                            </CostButton>
                          ) : null}
                        </div>
                      )}
                    </div>
                    {candidates.length > 1 ? (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10.5px] text-[var(--fg-4)]">候选视频 · 勾选用于导出</span>
                          <span className="font-mono text-[10px] text-[var(--fg-4)]">{candidates.length} 条</span>
                        </div>
                        <div className="flex gap-1.5 overflow-x-auto pb-1">
                          {candidates.map((v, i) => {
                            const active = !!v.selected || selected?.id === v.id;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                disabled={v.id === '__legacy__' || shotBlocked}
                                onClick={() => selectVideo(s.id, v.id)}
                                className={
                                  'flex shrink-0 flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors '
                                  + (active
                                    ? 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-[var(--accent)]'
                                    : 'border-[var(--line)] bg-white/[0.02] text-[var(--fg-3)] hover:border-[var(--line-strong)] hover:text-[var(--fg-2)]')
                                }
                              >
                                <span className="text-[11px] font-medium">候选 {i + 1}</span>
                                <span className="font-mono text-[9.5px] opacity-70">{v.seed ? 'seed ' + v.seed : '—'}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    {s.error ? (
                      <p className="m-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--danger)]">
                        {s.error}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="section-label">参考素材</span>
                      {!running && canEdit && features.buttons?.upload !== false ? (
                        <div className="flex flex-wrap gap-1">
                          {[
                            ['character', '角色'],
                            ['scene', '场景'],
                            ['prop', '道具'],
                            ['costume', '服装'],
                            ['age', '年龄'],
                            ['audio', '音频'],
                          ]
                            .filter(([k]) => features.assetCategories?.[k] !== false)
                            .map(([k, label]) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => openMaterial(s.id, k, 'add')}
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-white/[0.02] px-2 py-1 text-[10.5px] text-[var(--fg-3)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--fg-2)]"
                            >
                              <AssetCategoryIcon category={k} size={10} />
                              {label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {chars.length || scenes.length || props.length || costumes.length || ages.length || voices.length || audios.length ? (
                      <div className="flex flex-wrap gap-2">
                        {chars.map((a) => (
                          <RefThumb key={a.id} projectId={projectId} a={a} onPreview={setPreview} onReplace={!running && canEdit && features.buttons?.upload !== false ? () => openMaterial(s.id, 'character', 'replace', a.id) : null} onRemove={!running && canEdit && features.buttons?.upload !== false ? () => removeMaterial(s.id, 'character', a.id) : null} />
                        ))}
                        {scenes.map((a) => (
                          <RefThumb key={a.id} projectId={projectId} a={a} onPreview={setPreview} onReplace={!running && canEdit && features.buttons?.upload !== false ? () => openMaterial(s.id, 'scene', 'replace', a.id) : null} onRemove={!running && canEdit && features.buttons?.upload !== false ? () => removeMaterial(s.id, 'scene', a.id) : null} />
                        ))}
                        {props.map((a) => (
                          <RefThumb key={a.id} projectId={projectId} a={a} onPreview={setPreview} onReplace={!running && canEdit && features.buttons?.upload !== false ? () => openMaterial(s.id, 'prop', 'replace', a.id) : null} onRemove={!running && canEdit && features.buttons?.upload !== false ? () => removeMaterial(s.id, 'prop', a.id) : null} />
                        ))}
                        {costumes.map((a) => (
                          <RefThumb key={a.id} projectId={projectId} a={a} onPreview={setPreview} onReplace={!running && canEdit && features.buttons?.upload !== false ? () => openMaterial(s.id, 'costume', 'replace', a.id) : null} onRemove={!running && canEdit && features.buttons?.upload !== false ? () => removeMaterial(s.id, 'costume', a.id) : null} />
                        ))}
                        {ages.map((a) => (
                          <RefThumb key={a.id} projectId={projectId} a={a} onPreview={setPreview} onReplace={!running && canEdit && features.buttons?.upload !== false ? () => openMaterial(s.id, 'age', 'replace', a.id) : null} onRemove={!running && canEdit && features.buttons?.upload !== false ? () => removeMaterial(s.id, 'age', a.id) : null} />
                        ))}
                        {voices.map((v, i) => (
                          <div key={'voice_' + i} className="flex w-[150px] flex-col gap-1 rounded-lg border border-[var(--line)] bg-white/[0.02] p-1.5">
                            <audio controls src={fileUrl(projectId, v.voice_ref)} className="h-8 w-full" />
                            <span className="truncate text-[10px] text-[var(--fg-3)]">音色 · {v.name}</span>
                          </div>
                        ))}
                        {audios.map((a) => (
                          <div key={a.id} className="flex w-[150px] flex-col gap-1 rounded-lg border border-[var(--line)] bg-white/[0.02] p-1.5">
                            {a.audio_path || a.voice_ref ? (
                              <audio controls src={fileUrl(projectId, a.audio_path || a.voice_ref)} className="h-8 w-full" />
                            ) : (
                              <span className="py-2 text-[10px] text-[var(--fg-4)]">（无音频文件）</span>
                            )}
                            <span className="flex items-center justify-between gap-1">
                              <span className="truncate text-[10px] text-[var(--fg-3)]">{a.name}</span>
                              {!running && canEdit && features.buttons?.upload !== false ? (
                                <span className="flex shrink-0 gap-0.5">
                                  <button type="button" className="rounded px-1 text-[10px] text-[var(--fg-3)] hover:text-[var(--fg)]" onClick={() => openMaterial(s.id, 'audio', 'replace', a.id)}>
                                    替换
                                  </button>
                                  <button type="button" className="rounded px-1 text-[10px] text-[var(--fg-3)] hover:text-[var(--danger)]" onClick={() => removeMaterial(s.id, 'audio', a.id)}>
                                    ×
                                  </button>
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-[var(--fg-4)]">（无参考素材，Agent 会按文本推断）</span>
                    )}

                    <details className="group rounded-xl border border-[var(--line)] bg-white/[0.015]">
                      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11.5px] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-2)]">
                        提示词 & 分镜脚本
                        <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="flex flex-col gap-2 border-t border-[var(--line)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--fg-2)]">
                        {s.camera ? <Detail label="镜头" value={s.camera} /> : null}
                        {s.visual ? <Detail label="画面" value={s.visual} /> : null}
                        {s.dialogue ? <Detail label="台词" value={s.dialogue} /> : null}
                        {s.narration ? <Detail label="旁白" value={s.narration} /> : null}
                        {s.sub_shots ? <Detail label="子镜头" value={s.sub_shots} pre /> : null}
                        <div>
                          <span className="text-[var(--fg-4)]">视频提示词</span>
                          <pre className="logbox mt-1 max-h-[200px] whitespace-pre-wrap text-[11px]">{s.video_prompt || '（未生成）'}</pre>
                        </div>
                        {s.prompt_id ? <span className="font-mono text-[10px] text-[var(--fg-4)]">ComfyUI prompt_id: {s.prompt_id}</span> : null}
                      </div>
                    </details>
                  </div>
                </div>

                {!canGenerate || features.buttons?.generate === false ? null : (
                  <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-4 py-3">
                    <Input
                      value={feedback[s.id] || ''}
                      onChange={(e) => setFeedback({ ...feedback, [s.id]: e.target.value })}
                      placeholder={s.video_path ? '反馈（可选）：如「镜头拉近 / 让人物微笑」' : '可留空直接生成此镜视频；填写后先由 LLM 改写提示词'}
                      className="h-9 min-w-[220px] flex-1 text-[12.5px]"
                    />
                    <CostButton
                      variant="ghost"
                      size="sm"
                      disabled={shotBlocked || submitting === s.id || !(feedback[s.id] || '').trim()}
                      title={chapterJob ? '本章任务运行中，暂不能单独改写本镜' : '只让 LLM 按反馈改写提示词，不生成视频'}
                      cost={shotBlocked || submitting === s.id ? '' : costLabel(billing, 'llmRewritePerCall', 1)}
                      onClick={() => regen(s.id, false)}
                    >
                      <Wand2 size={12} /> 仅改写提示词
                    </CostButton>
                    {s.video_path || candidates.length ? (
                      <CostButton
                        variant="secondary"
                        size="sm"
                        disabled={shotBlocked || submitting === s.id}
                        title="保留已有候选，再生成一条新候选；生成后在左侧勾选导出用"
                        cost={shotBlocked || submitting === s.id ? '' : costText(billing, 'videoPerSecond', s.duration)}
                        onClick={() => regen(s.id, true, true)}
                      >
                        <Plus size={12} /> 生成候选
                      </CostButton>
                    ) : null}
                    <CostButton
                      variant={s.video_path ? 'secondary' : 'primary'}
                      size="sm"
                      disabled={shotBlocked || submitting === s.id}
                      cost={!shotBlocked && submitting !== s.id ? costText(billing, 'videoPerSecond', s.duration) : ''}
                      onClick={() => onRegen(s.id)}
                    >
                      {submitting === s.id ? (
                        '提交中…'
                      ) : job ? (
                        job.status === 'queued' ? (
                          '排队中…'
                        ) : (
                          '生成中…'
                        )
                      ) : chapterJob ? (
                        '本章生成中…'
                      ) : s.video_path ? (
                        <>
                          <RefreshCw size={12} /> 重新生成
                        </>
                      ) : (
                        <>
                          <Play size={12} /> 生成此镜视频
                        </>
                      )}
                    </CostButton>
                  </footer>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={Clapperboard}
            title="暂无分镜"
            description="先生成章节与素材；分镜会按章节拆分，并在这里逐镜审查。"
          />
        </div>
      )}

      <ImageLightbox
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        src={preview ? fileUrl(projectId, preview.image_path) : null}
        title={preview?.name}
        subtitle={preview?.category}
      />

      <Modal
        open={!!ask}
        onOpenChange={(o) => !o && setAsk(null)}
        title="检测到反馈，需要 LLM 改写提示词"
        size="md"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setAsk(null)}>
              取消
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                const id = ask;
                setAsk(null);
                regen(id, false);
              }}
            >
              只改写，不渲染
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                const id = ask;
                setAsk(null);
                regen(id, true);
              }}
            >
              改写后渲染视频
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-[var(--line)] bg-white/[0.02] p-3 text-[12px] leading-relaxed text-[var(--fg-2)]">
            <span className="text-[var(--fg-4)]">反馈：</span>
            {ask ? feedback[ask] || '' : ''}
          </div>
          <p className="m-0 text-[12.5px] leading-relaxed text-[var(--fg-3)]">LLM 改写完成后，是否继续调用 ComfyUI 渲染视频？</p>
        </div>
      </Modal>

      {materialPicker ? (
        <MaterialPicker
          projectId={projectId}
          assets={assets}
          category={materialPicker.category}
          mode={materialPicker.mode}
          replaceAssetId={materialPicker.replaceAssetId}
          assignedIds={asArray((shots.find((s) => s.id === materialPicker.shotId) || {})[MATERIAL_FIELD[materialPicker.category]])}
          charIds={asArray((shots.find((s) => s.id === materialPicker.shotId) || {}).character_ids)}
          onPick={applyMaterial}
          onCancel={() => setMaterialPicker(null)}
        />
      ) : null}

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}

function Detail({ label, value, pre }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-[var(--fg-4)]">{label}</span>
      {pre ? <pre className="m-0 whitespace-pre-wrap font-sans">{value}</pre> : <span>{value}</span>}
    </div>
  );
}

function RefThumb({ projectId, a, onPreview, onReplace, onRemove }) {
  return (
    <div className="group/ref relative flex w-[72px] flex-col gap-1">
      <div
        role="button"
        tabIndex={0}
        onClick={() => a.image_path && onPreview(a)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && a.image_path) {
            e.preventDefault();
            onPreview(a);
          }
        }}
        className="relative h-[64px] w-[64px] cursor-zoom-in overflow-hidden rounded-lg border border-[var(--line)] bg-black/30"
      >        {a.image_path ? (
          <img src={fileUrl(projectId, a.image_path)} alt={a.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[9px] text-[var(--fg-4)]">{ASSET_CATEGORY_LABEL[a.category] || a.category}</span>
        )}
        {onReplace || onRemove ? (
          <span className="absolute inset-0 flex items-center justify-center gap-1 bg-black/60 opacity-0 transition-opacity group-hover/ref:opacity-100">
            {onReplace ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onReplace();
                }}
                className="rounded bg-white/10 px-1 py-0.5 text-[9px] text-white/90 hover:bg-white/20"
              >
                替换
              </span>
            ) : null}
            {onRemove ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                className="rounded bg-white/10 px-1 py-0.5 text-[9px] text-white/90 hover:bg-white/20"
              >
                ×
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <span className="truncate text-[9.5px] leading-tight text-[var(--fg-3)]" title={a.name}>
        {a.name}
      </span>
    </div>
  );
}
