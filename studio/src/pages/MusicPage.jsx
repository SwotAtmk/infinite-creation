import { useCallback, useEffect, useState } from 'react';
import { Clock, Link2, Music4, Pencil, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../lib/api.js';
import CostButton from '../components/CostButton.jsx';
import { fileUrl } from '../lib/format.js';
import { Badge, Button, Checkbox, EmptyState, Field, Input, StatusPill, Textarea } from '../components/ui.jsx';
import { BusyOverlay, Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

const STATUS_LABEL = { pending: '待生成', generating: '生成中', done: '完成', failed: '生成失败' };

export default function MusicPage({ projectId, chapters, running, onRefresh, readOnly = false, canEdit = true, canGenerate = true, features = {} }) {
  const toast = useToast();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [genOpen, setGenOpen] = useState(false);
  const [genAssetId, setGenAssetId] = useState(null);
  const [genForm, setGenForm] = useState({ name: '', caption: '', lyrics: '', max_duration: '' });
  const [detailId, setDetailId] = useState(null);
  const [applyTarget, setApplyTarget] = useState(null);
  const [applySelection, setApplySelection] = useState([]);
  const [busy, setBusy] = useState(null);

  const detailAsset = detailId ? assets.find((a) => a.id === detailId) || null : null;

  const load = useCallback(
    () => api.get('/api/projects/' + projectId + '/assets?category=music').then(setAssets).catch((e) => toast.error(e.message)),
    [projectId],
  );

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const doneChapters = chapters.filter((c) => c.genStatus === 'done');

  function openNew() {
    setGenAssetId(null);
    setGenForm({ name: '', caption: '', lyrics: '', max_duration: '' });
    setGenOpen(true);
  }

  function openEdit(a) {
    setGenAssetId(a.id);
    setGenForm({ name: a.name || '', caption: a.prompt || '', lyrics: a.lyrics || '', max_duration: a.max_duration ? String(a.max_duration) : '' });
    setGenOpen(true);
  }

  async function generateMusic() {
    if (!genForm.caption.trim()) {
      toast.error('请填写音乐描述 caption');
      return;
    }
    setBusy('正在提交背景音乐生成…');
    try {
      await api.post('/api/projects/' + projectId + '/music', {
        asset_id: genAssetId || undefined,
        name: genForm.name || undefined,
        caption: genForm.caption,
        lyrics: genForm.lyrics || undefined,
        max_duration: genForm.max_duration ? Number(genForm.max_duration) : undefined,
      });
      toast.success('已提交背景音乐生成，列表会出现「生成中」记录，稍后自动完成');
      setGenOpen(false);
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function retryGenerate(a) {
    setBusy('正在重新生成背景音乐…');
    try {
      await api.post('/api/projects/' + projectId + '/music', { asset_id: a.id });
      toast.success('已重新提交背景音乐生成');
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  function toggleChapter(title) {
    setApplySelection((prev) => (prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]));
  }

  async function applyMusic() {
    if (!applyTarget || !applySelection.length) return;
    setBusy('正在应用背景音乐并合成成片…');
    try {
      await api.post('/api/projects/' + projectId + '/music/apply', { music_id: applyTarget, chapters: applySelection });
      toast.success('已提交背景音乐应用，逐章进度与失败原因见「运行日志」，完成后可在「成片」页预览');
      setApplyTarget(null);
      setApplySelection([]);
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sound"
        title="背景音乐"
        description="纯音乐或带歌词均可；生成后选择章节合成，最终视频会写入音乐轨。"
        actions={
          (!canGenerate || features.buttons?.generate === false) ? null : (
            <Button variant="primary" size="md" disabled={running} onClick={openNew}>
              <Plus size={14} /> 生成背景音乐
            </Button>
          )
        }
      />

      {loading ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="panel p-4">
              <div className="skeleton h-4 w-1/2 rounded" />
              <div className="skeleton mt-3 h-9 w-full rounded" />
              <div className="skeleton mt-3 h-3 w-2/3 rounded" />
            </div>
          ))}
        </div>
      ) : assets.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {assets.map((a) => {
            const isGenerating = a.status === 'generating';
            return (
              <article key={a.id} className="panel panel-hover flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
                      <Music4 size={14} />
                    </span>
                    <div className="min-w-0">
                      <h3 className="m-0 truncate text-[13px] font-medium text-[var(--fg)]" title={a.name}>
                        {a.name}
                      </h3>
                      <p className="m-0 mt-0.5 flex items-center gap-1 text-[10px] text-[var(--fg-4)]">
                        <Clock size={10} className="opacity-70" />
                        {a.max_duration ? '最长 ' + a.max_duration + ' 秒' : '时长自适应'}
                      </p>
                    </div>
                  </div>
                  <StatusPill status={a.status}>{STATUS_LABEL[a.status] || a.status}</StatusPill>
                </div>

                {a.audio_path ? (
                  <audio src={fileUrl(projectId, a.audio_path)} controls preload="metadata" className="h-9 w-full" />
                ) : (
                  <div className="flex h-9 items-center justify-center rounded-lg border border-[var(--line)] bg-white/[0.02] text-[11px] text-[var(--fg-4)]">
                    {isGenerating ? '生成中…' : '（无音频文件）'}
                  </div>
                )}

                {a.prompt ? <p className="m-0 line-clamp-2 text-[11px] leading-relaxed text-[var(--fg-3)]">{a.prompt}</p> : null}

                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => setDetailId(a.id)}>
                    详情
                  </Button>
                  {!isGenerating && canEdit ? (
                    <Button variant="ghost" size="iconSm" title="编辑" aria-label="编辑" onClick={() => openEdit(a)}>
                      <Pencil size={13} />
                    </Button>
                  ) : null}
                  {a.status === 'failed' && canGenerate && features.buttons?.generate !== false ? (
                    <CostButton
                      variant="secondary"
                      size="sm"
                      disabled={running}
                      onClick={() => retryGenerate(a)}
                    >
                      <RefreshCw size={12} /> 重新生成
                    </CostButton>
                  ) : null}
                  {a.status === 'done' && a.audio_path && canGenerate && features.buttons?.generate !== false ? (
                    <Button
                      variant="primary"
                      size="sm"
                      className="ml-auto"
                      disabled={running}
                      onClick={() => {
                        setApplyTarget(a.id);
                        setApplySelection([]);
                      }}
                    >
                      <Link2 size={12} /> 应用到
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={Music4}
            title="暂无背景音乐"
            description="描述想要的氛围与乐器，Agent 会生成音乐；生成后可选择已完成的章节合成。"
            action={
              (!canGenerate || features.buttons?.generate === false) ? null : (
                <Button variant="primary" size="md" onClick={openNew}>
                  <Plus size={14} /> 生成背景音乐
                </Button>
              )
            }
          />
        </div>
      )}

      <Modal
        open={genOpen}
        onOpenChange={setGenOpen}
        title={genAssetId ? '编辑背景音乐' : '生成背景音乐'}
        description="描述越具体，生成的氛围越贴近预期；纯音乐请把歌词留空。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setGenOpen(false)}>
              取消
            </Button>
            <CostButton
              variant="primary"
              size="md"
              disabled={!!busy}
              onClick={generateMusic}
            >
              <Sparkles size={13} /> {genAssetId ? '保存并重新生成' : '生成'}
            </CostButton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="名称（可空）">
            <Input value={genForm.name} onChange={(e) => setGenForm({ ...genForm, name: e.target.value })} placeholder="留空自动命名" />
          </Field>
          <Field label="音乐描述 caption" required>
            <Textarea
              rows={3}
              value={genForm.caption}
              onChange={(e) => setGenForm({ ...genForm, caption: e.target.value })}
              placeholder="如：轻柔舒缓的钢琴纯音乐，适合夜晚治愈氛围"
            />
          </Field>
          <Field label="歌词 lyrics（可空，纯音乐留空）">
            <Textarea rows={3} value={genForm.lyrics} onChange={(e) => setGenForm({ ...genForm, lyrics: e.target.value })} placeholder="可留空" />
          </Field>
          <p className="m-0 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
          </p>
          <Field label="最大时长（秒，可空）" hint="留空按项目总时长。">
            <Input
              type="number"
              min="1"
              value={genForm.max_duration}
              onChange={(e) => setGenForm({ ...genForm, max_duration: e.target.value })}
              placeholder="例如 90"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!detailAsset}
        onOpenChange={(o) => !o && setDetailId(null)}
        title="背景音乐详情"
        description={detailAsset?.name}
        size="lg"
        footer={
          <Button variant="secondary" size="md" onClick={() => setDetailId(null)}>
            关闭
          </Button>
        }
      >
        {detailAsset ? (
          <div className="flex flex-col gap-3 text-[12px] leading-relaxed text-[var(--fg-2)]">
            <div className="flex items-center gap-2">
              <StatusPill status={detailAsset.status}>{STATUS_LABEL[detailAsset.status] || detailAsset.status}</StatusPill>
              <Badge tone="neutral">{detailAsset.category}</Badge>
              <span className="text-[11px] text-[var(--fg-3)]">{detailAsset.max_duration ? detailAsset.max_duration + ' 秒' : '时长自适应'}</span>
            </div>
            <div>
              <span className="text-[var(--fg-4)]">音乐描述</span>
              <div className="logbox mt-1 max-h-[140px]">{detailAsset.prompt || '（无）'}</div>
            </div>
            <div>
              <span className="text-[var(--fg-4)]">歌词</span>
              <div className="logbox mt-1 max-h-[140px]">{detailAsset.lyrics || '（无）'}</div>
            </div>
            {detailAsset.audio_path ? <audio src={fileUrl(projectId, detailAsset.audio_path)} controls className="h-10 w-full" /> : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!applyTarget}
        onOpenChange={(o) => !o && setApplyTarget(null)}
        title="应用到章节"
        description="选择要应用该背景音乐的章节（仅已全部生成完成的章节可选）。"
        size="md"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setApplyTarget(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!applySelection.length || !!busy} onClick={applyMusic}>
              应用（{applySelection.length}）
            </Button>
          </>
        }
      >
        {doneChapters.length ? (
          <div className="flex flex-col gap-2">
            {doneChapters.map((c) => (
              <div key={c.title} className="rounded-lg border border-[var(--line)] bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-[var(--line-strong)]">
                <Checkbox checked={applySelection.includes(c.title)} onChange={() => toggleChapter(c.title)} label={c.title} className="w-full" />
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-[12px] text-[var(--fg-3)]">暂无已生成完成的章节。</p>
        )}
      </Modal>

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}
