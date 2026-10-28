import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Image as ImageIcon,
  Layers,
  Mic2,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { api, uploadBinary } from '../lib/api.js';
import CostButton from '../components/CostButton.jsx';
import { fileUrl, STATUS_TEXT } from '../lib/format.js';
import { ASSET_CATEGORIES } from '../lib/shared.js';
import { AssetCategoryIcon } from '../components/visuals.jsx';
import { Badge, Button, EmptyState, Field, Input, SearchInput, Segmented, Select, StatusPill, Textarea } from '../components/ui.jsx';
import { BusyOverlay, Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { AssetMedia, ImageLightbox } from '../components/media.jsx';
import { useToast } from '../components/toast.jsx';

const CATEGORY_OPTIONS = ASSET_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));
const CATEGORY_LABEL = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.id, c.label]));
const IMAGE_CATEGORIES = ['character', 'scene', 'prop', 'other'];

export default function AssetsPage({ projectId, jobs = [], onRefresh, readOnly = false, canEdit = true, canGenerate = true, features = {} }) {
  const toast = useToast();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cat, setCat] = useState('');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ category: 'character', name: '', description: '', parent_id: '' });
  const [edit, setEdit] = useState(null);
  const [voice, setVoice] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [outfits, setOutfits] = useState({});
  const [ages, setAges] = useState({});
  const uploadTargetRef = useRef(null);
  const fileRef = useRef(null);

  const load = useCallback(
    () => api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch((e) => toast.error(e.message)),
    [projectId],
  );

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const counts = useMemo(() => {
    const m = { '': assets.length };
    for (const a of assets) m[a.category] = (m[a.category] || 0) + 1;
    return m;
  }, [assets]);

  const shownAssets = assets.filter(
    (a) =>
      features.assetCategories?.[a.category] !== false &&
      (!cat || a.category === cat) &&
      (!query.trim() || (a.name || '').toLowerCase().includes(query.trim().toLowerCase())),
  );

  const characters = assets.filter((a) => a.category === 'character');
  const isVariantForm = form.category === 'costume' || form.category === 'age';
  const costumesOfChar = (charId) => assets.filter((a) => a.category === 'costume' && a.parent_id === charId);
  const agesOfChar = (charId) => assets.filter((a) => a.category === 'age' && a.parent_id === charId);
  const editingAsset = edit ? assets.find((x) => x.id === edit.id) : null;
  const voiceAsset = voice ? assets.find((x) => x.id === voice.id) : null;
  const activeJobFor = (subject) =>
    jobs.find((j) => (j.status === 'running' || j.status === 'queued') && j.checkpoint && j.checkpoint.subject === subject);

  function designVoice(a) {
    setVoice({ id: a.id, name: a.name, voice_desc: a.voice_desc || '', voice_ref: a.voice_ref || '' });
    api
      .get('/api/projects/' + projectId + '/assets/' + a.id)
      .then((x) => {
        setVoice((v) => (v && v.id === a.id ? { ...v, voice_desc: x.voice_desc || '', voice_ref: x.voice_ref || '', refreshAt: Date.now() } : v));
      })
      .catch(() => {});
  }

  async function saveVoice() {
    setBusy('正在保存声音限制…');
    try {
      await api.patch('/api/projects/' + projectId + '/assets/' + voice.id, { voice_desc: voice.voice_desc });
      toast.success('已保存声音限制');
      setVoice(null);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function regenVoice() {
    setBusy('正在提交音色设计…');
    try {
      await api.patch('/api/projects/' + projectId + '/assets/' + voice.id, { voice_desc: voice.voice_desc });
      await api.post('/api/projects/' + projectId + '/assets/' + voice.id + '/design-voice', { voice_description: voice.voice_desc });
      toast.success('已提交音色设计，稍后在「运行日志」查看进度');
      setVoice(null);
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  function pickUpload(a) {
    uploadTargetRef.current = a.id;
    fileRef.current?.click();
  }

  async function doUpload(aid, file) {
    if (!file) return;
    setBusy('正在上传 / 替换素材…');
    try {
      await uploadBinary('/api/projects/' + projectId + '/assets/' + aid + '/upload', file, 'application/octet-stream');
      load();
    } catch (e) {
      toast.error('上传失败：' + e.message);
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    setBusy('正在新建资产…');
    try {
      await api.post('/api/projects/' + projectId + '/assets', form);
      setForm({ ...form, name: '', description: '' });
      setCreateOpen(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function del(a) {
    if (!(await toast.confirm('删除资产「' + a.name + '」？此操作不可逆。', { danger: true }))) return;
    setBusy('正在删除资产…');
    try {
      await api.del('/api/projects/' + projectId + '/assets/' + a.id);
      toast.success('已删除「' + a.name + '」');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function regenImage(a, mode) {
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/generate', { mode: mode || 't2i' });
      toast.success((mode === 'i2i' ? '已提交重新生成（图生图，基于现有图）' : '已提交生成图片') + '，稍后在「运行日志」查看进度');
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function changeOutfit(a) {
    const outfit = await toast.prompt('输入服装描述（如：冬季红色斗篷 / 校园制服 / 战斗铠甲）', {
      defaultValue: outfits[a.id] || '',
      placeholder: '服装描述',
    });
    if (!outfit) return;
    setOutfits({ ...outfits, [a.id]: outfit });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-outfit', { outfit });
      toast.success('已提交换装（图生图），稍后在「运行日志」查看进度');
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function changeAge(a) {
    const age = await toast.prompt('输入年龄 / 时期描述（如：年轻时 / 中年时 / 老年时）', {
      defaultValue: ages[a.id] || '',
      placeholder: '年龄 / 时期描述',
    });
    if (!age) return;
    setAges({ ...ages, [a.id]: age });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-age', { age });
      toast.success('已提交年龄变化（图生图），稍后在「运行日志」查看进度');
      load();
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function saveEdit() {
    setBusy('正在保存资产…');
    try {
      await api.patch('/api/projects/' + projectId + '/assets/' + edit.id, {
        name: edit.name,
        description: edit.description,
        prompt: edit.prompt,
      });
      toast.success('已保存');
      setEdit(null);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  function primaryAction(a) {
    if (readOnly || !canGenerate || features.buttons?.generate === false) return null;
    const active = activeJobFor(a.id);
    if (IMAGE_CATEGORIES.includes(a.category)) {
      return (
        <CostButton
          variant="primary"
          size="sm"
          className="flex-1"
          disabled={!!active}
          loading={active && active.status === 'running'}
          onClick={() => regenImage(a, a.image_path ? 'i2i' : 't2i')}
        >
          <Wand2 size={12} /> {a.image_path ? '重新生成' : '生成图'}
        </CostButton>
      );
    }
    if (a.category === 'character' || a.category === 'voice') {
      return (
        <CostButton
          variant="primary"
          size="sm"
          className="flex-1"
          disabled={!!active}
          onClick={() => designVoice(a)}
        >
          <Mic2 size={12} /> 设计音色
        </CostButton>
      );
    }
    if (features.buttons?.upload === false) return null;
    return (
      <Button variant="secondary" size="sm" className="flex-1" onClick={() => pickUpload(a)}>
        <Upload size={12} /> 上传 / 替换
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Library"
        title="素材库"
        description="角色、场景、道具与音色全项目共用、跨章节复用；服装 / 年龄变体挂在角色下才能被生成流程引用。"
        actions={
          !canEdit ? null : (
            <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> 新建资产
            </Button>
          )
        }
      />

      <div className="panel flex flex-wrap items-center justify-between gap-3 p-2.5">
        <Segmented
          value={cat}
          onChange={setCat}
          options={[
            { value: '', label: '全部', count: counts[''] || 0, icon: <Layers size={12} /> },
            ...ASSET_CATEGORIES.filter((c) => features.assetCategories?.[c.id] !== false).map((c) => ({ value: c.id, label: c.label, count: counts[c.id] || 0, icon: <AssetCategoryIcon category={c.id} size={12} /> })),
          ]}
          className="max-w-full overflow-x-auto"
        />
        <SearchInput value={query} onChange={setQuery} placeholder="按名称搜索素材" className="ml-auto w-[220px] max-w-full" />
      </div>

      {loading ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="panel overflow-hidden">
              <div className="skeleton aspect-square rounded-none" />
              <div className="flex flex-col gap-2 p-3">
                <div className="skeleton h-3.5 w-2/3 rounded" />
                <div className="skeleton h-3 w-1/2 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : shownAssets.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
          {shownAssets.map((a) => {
            const active = activeJobFor(a.id);
            const parent = (a.category === 'costume' || a.category === 'age') && a.parent_id ? assets.find((x) => x.id === a.parent_id) : null;
            const costumes = a.category === 'character' ? costumesOfChar(a.id) : [];
            const ageVariants = a.category === 'character' ? agesOfChar(a.id) : [];
            return (
              <article key={a.id} className="panel panel-hover group flex flex-col overflow-hidden">
                <div className="relative aspect-square overflow-hidden bg-black/30">
                  <AssetMedia projectId={projectId} asset={a} onPreview={a.image_path ? () => setPreview(a) : undefined} />
                  <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                    <StatusPill status={a.status}>{STATUS_TEXT[a.status] || a.status}</StatusPill>
                    {active ? <Badge tone={active.status === 'queued' ? 'info' : 'accent'} dot>{active.status === 'queued' ? '排队中' : '生成中'}</Badge> : null}
                  </div>
                  <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <AssetMenu
                      asset={a}
                      active={active}
                      features={features}
                      onGenerate={() => regenImage(a, 't2i')}
                      onRegenI2I={() => regenImage(a, 'i2i')}
                      onOutfit={() => changeOutfit(a)}
                      onAge={() => changeAge(a)}
                      onVoice={() => designVoice(a)}
                      onUpload={() => pickUpload(a)}
                      onEdit={() => setEdit({ id: a.id, name: a.name, description: a.description || '', prompt: a.prompt || '' })}
                      onDelete={() => del(a)}
                    />
                  </div>
                </div>

                <div className="flex flex-1 flex-col gap-2 p-3">
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-[13px] font-medium text-[var(--fg)]" title={a.name}>
                      {a.name}
                    </h3>
                    <p className="m-0 mt-0.5 flex items-center gap-1 truncate text-[10.5px] text-[var(--fg-3)]">
                      <AssetCategoryIcon category={a.category} size={10} />
                      {CATEGORY_LABEL[a.category] || a.category}
                      {parent ? ' · 来自「' + parent.name + '」' : ''}
                    </p>
                  </div>

                  {(a.voice_ref || a.audio_path) && (a.image_path || a.video_path) ? (
                    <div className="flex flex-col gap-1">
                      <span className="text-[9.5px] uppercase tracking-[.14em] text-[var(--fg-4)]">音色试听</span>
                      <audio src={fileUrl(projectId, a.voice_ref || a.audio_path)} controls className="h-8 w-full" />
                    </div>
                  ) : null}

                  {features.assetCategories?.costume !== false && costumes.length ? <VariantStrip label="服装" projectId={projectId} items={costumes} onPreview={setPreview} /> : null}
                  {features.assetCategories?.age !== false && ageVariants.length ? <VariantStrip label="年龄 / 时期" projectId={projectId} items={ageVariants} onPreview={setPreview} /> : null}

                  <div className="mt-auto flex items-center gap-1.5 pt-0.5">
                    {primaryAction(a)}
                    {canEdit ? (
                      <Button variant="secondary" size="iconSm" title="编辑" aria-label="编辑" onClick={() => setEdit({ id: a.id, name: a.name, description: a.description || '', prompt: a.prompt || '' })}>
                        <Pencil size={13} />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={Palette}
            title={assets.length ? '没有匹配的素材' : '还没有素材'}
            description={assets.length ? '换个分类或清空搜索再试。' : '先建角色、场景、道具，或在章节页上传参考图导入素材库。'}
            action={
              !assets.length && canEdit ? (
                <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
                  <Plus size={14} /> 新建资产
                </Button>
              ) : null
            }
          />
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f && uploadTargetRef.current) doUpload(uploadTargetRef.current, f);
          e.target.value = '';
          uploadTargetRef.current = null;
        }}
      />

      <ImageLightbox
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        src={preview ? fileUrl(projectId, preview.image_path) : null}
        title={preview?.name}
        subtitle={preview ? CATEGORY_LABEL[preview.category] || preview.category : null}
      />

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建资产"
        description="素材库为全项目共用；角色 / 场景 / 道具可由 Agent 生成，也可之后单独补图。"
        size="md"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!form.name || (isVariantForm && !form.parent_id)} onClick={create}>
              添加
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="资产分类">
            <Select
              value={form.category}
              onChange={(v) => setForm({ ...form, category: v, parent_id: '' })}
              items={CATEGORY_OPTIONS.filter((o) => features.assetCategories?.[o.value] !== false).map((o) => ({ ...o, icon: <AssetCategoryIcon category={o.value} size={13} /> }))}
            />
          </Field>
          {isVariantForm ? (
            <>
              <Field label="所属角色" hint="服装 / 年龄必须是某个角色的变体，否则生成时会被忽略。">
                <Select
                  value={form.parent_id}
                  onChange={(v) => setForm({ ...form, parent_id: v })}
                  items={characters.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="选择角色"
                />
              </Field>
              {!characters.length ? (
                <p className="m-0 text-[11.5px] leading-relaxed text-[var(--accent)]">还没有角色素材：请先新建一个「人物」资产。</p>
              ) : null}
            </>
          ) : null}
          <Field label="名称" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：红袍少年" />
          </Field>
          <Field label="描述（可选）" hint="留空时 Agent 会根据故事自动补全。">
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="外形、气质、服装、年龄…" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        title="编辑素材"
        description={editingAsset ? editingAsset.name : ''}
        size="2xl"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" onClick={saveEdit}>
              保存
            </Button>
          </>
        }
      >
        {edit ? (
          <div className="flex flex-wrap items-start gap-5">
            <div className="w-[280px] max-w-full shrink-0">
              <div className="media-frame aspect-square overflow-hidden">
                {editingAsset ? <AssetMedia projectId={projectId} asset={editingAsset} /> : null}
              </div>
              {editingAsset ? (
                <p className="m-0 mt-2 text-[11px] text-[var(--fg-3)]">
                  {CATEGORY_LABEL[editingAsset.category]}
                  {(editingAsset.category === 'costume' || editingAsset.category === 'age') && editingAsset.parent_id
                    ? ' · 来自「' + (assets.find((x) => x.id === editingAsset.parent_id)?.name || editingAsset.parent_id) + '」'
                    : ''}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-[260px] flex-1 flex-col gap-3.5">
              <Field label="名称">
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label="描述">
                <Textarea rows={4} value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="描述（可选，Agent 会自动补全）" />
              </Field>
              <Field
                label="提示词"
                hint={editingAsset?.prompt_locked ? '已锁定：LLM 阶段不会覆盖这段提示词（清空保存即解锁）。' : '保存后即锁定：LLM 阶段不会覆盖你写的提示词；清空保存即解锁。'}
              >
                <Textarea rows={7} value={edit.prompt || ''} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} placeholder="提示词（可选，用于生成 / 重新生成）" />
              </Field>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!voice}
        onOpenChange={(o) => !o && setVoice(null)}
        title={'设计音色' + (voice ? ' · ' + voice.name : '')}
        description="声音限制会写入资产，并作为 TTS 工作流的声音描述输入。"
        size="2xl"
      >
        {voice ? (
          <div className="flex flex-wrap items-start gap-5">
            <div className="w-[280px] max-w-full shrink-0">
              {voiceAsset && (voiceAsset.audio_path || voice.voice_ref || voiceAsset.voice_ref) ? (
                <div className="panel-flat p-3">
                  <p className="m-0 mb-2 text-[10px] uppercase tracking-[.14em] text-[var(--fg-4)]">当前音色试听</p>
                  <audio src={fileUrl(projectId, voiceAsset.audio_path || voice.voice_ref || voiceAsset.voice_ref)} controls className="h-9 w-full" />
                </div>
              ) : (
                <div className="media-frame flex aspect-square items-center justify-center text-[11px] text-[var(--fg-4)]">尚无音色样本</div>
              )}
              <p className="m-0 mt-2.5 text-[11px] leading-relaxed text-[var(--fg-3)]">
                {!voice.voice_desc?.trim()
                  ? '尚未设置声音限制，生成时将由系统按角色性别 / 年龄自动推断。建议填写，避免男主生成女声。'
                  : '声音限制会作为 TTS 工作流的「声音描述」输入；朗读内容沿用当前文案。'}
              </p>
            </div>
            <div className="flex min-w-[260px] flex-1 flex-col gap-3">
              <Field label="声音限制（性别 / 年龄 / 质感）">
                <Textarea
                  rows={7}
                  value={voice.voice_desc || ''}
                  onChange={(e) => setVoice({ ...voice, voice_desc: e.target.value })}
                  placeholder="如：青年男性，嗓音低沉温和，语速偏慢，带一点书卷气的平静口吻"
                />
              </Field>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" size="md" onClick={() => setVoice(null)}>
                  取消
                </Button>
                <Button variant="secondary" size="md" onClick={saveVoice}>
                  保存
                </Button>
                <Button variant="primary" size="md" disabled={!!activeJobFor(voice.id)} onClick={regenVoice}>
                  <Sparkles size={13} /> 重新生成
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}

function VariantStrip({ label, projectId, items, onPreview }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9.5px] uppercase tracking-[.14em] text-[var(--fg-4)]">
        {label}（{items.length}）
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((v) => (
          <button
            key={v.id}
            type="button"
            title={v.name}
            onClick={() => v.image_path && onPreview(v)}
            className="group/v relative h-10 w-10 overflow-hidden rounded-md border border-[var(--line)] bg-black/30"
          >
            {v.image_path ? (
              <img src={fileUrl(projectId, v.image_path)} alt={v.name} loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[9px] text-[var(--fg-4)]">{label.slice(0, 2)}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssetMenu({ asset, active, features = {}, onGenerate, onRegenI2I, onOutfit, onAge, onVoice, onUpload, onEdit, onDelete }) {
  const canImage = IMAGE_CATEGORIES.includes(asset.category);
  const disabled = !!active;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="更多操作"
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-white/75 backdrop-blur transition-colors hover:text-white"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[260] min-w-[168px] rounded-xl border border-[var(--line-strong)] bg-[var(--panel-2)] p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,.95)]"
        >
          {canImage && features.buttons?.generate !== false ? (
            <MenuItem onSelect={onGenerate} disabled={disabled} icon={Wand2}>
              生成图（文生图）
            </MenuItem>
          ) : null}
          {canImage && asset.image_path && features.buttons?.generate !== false ? (
            <MenuItem onSelect={onRegenI2I} disabled={disabled} icon={ImageIcon}>
              重新生成（图生图）
            </MenuItem>
          ) : null}
          {asset.category === 'character' && asset.image_path && features.buttons?.generate !== false ? (
            <MenuItem onSelect={onOutfit} disabled={disabled} icon={Palette}>
              换装
            </MenuItem>
          ) : null}
          {asset.category === 'character' && asset.image_path && features.buttons?.generate !== false ? (
            <MenuItem onSelect={onAge} disabled={disabled} icon={Sparkles}>
              年龄变体
            </MenuItem>
          ) : null}
          {(asset.category === 'character' || asset.category === 'voice') && features.buttons?.generate !== false ? (
            <MenuItem onSelect={onVoice} disabled={disabled} icon={Mic2}>
              设计音色
            </MenuItem>
          ) : null}
          {features.buttons?.upload === false ? null : (
            <MenuItem onSelect={onUpload} icon={Upload}>
              上传 / 替换
            </MenuItem>
          )}
          <MenuItem onSelect={onEdit} icon={Pencil}>
            编辑
          </MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--line)]" />
          {features.buttons?.delete === false ? null : (
            <MenuItem onSelect={onDelete} icon={Trash2} danger>
              删除
            </MenuItem>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({ children, icon: Icon, onSelect, disabled, danger, cost }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] outline-none transition-colors',
        danger ? 'text-[var(--danger)] data-[highlighted]:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]' : 'text-[var(--fg-2)] data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-[var(--fg)]',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
      )}
    >
      {Icon ? <Icon size={13} /> : null}
      {children}
      {cost ? <span className="ml-auto pl-3 text-[10px] font-medium text-[var(--accent)]">{cost}</span> : null}
    </DropdownMenu.Item>
  );
}
