import { useEffect, useRef, useState } from 'react';
import { Eye, FileUp, List, Pencil, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { HW_PRESETS, RUNNINGHUB_WORKFLOWS, WORKFLOW_TASKS } from '../lib/shared.js';
import { Badge, Button, Checkbox, Field, Input, Segmented, Select, Textarea } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

// 语义角色名 → 中文标签（引导式表单用）。node/field 为空的行保存时会被忽略。
const ROLE_LABELS = {
  positive_prompt: '正向提示词',
  negative_prompt: '负向提示词',
  width: '宽',
  height: '高',
  seed: '种子',
  seconds: '时长（秒）',
  resolution: '分辨率',
  aspect_ratio: '宽高比',
  mode: '视频模式',
  scale: '超分倍率',
  image: '参考图（图生图）',
  text: '文本 / 台词',
  voice_description: '音色描述',
  ref_audio: '参考音频',
  caption: '音乐风格描述',
  lyrics: '歌词',
  max_duration: '最大时长',
  filename_prefix: '输出前缀',
};

const ROLES_BY_GROUP = {
  image: ['positive_prompt', 'negative_prompt', 'width', 'height', 'seed', 'image', 'filename_prefix'],
  video: ['positive_prompt', 'negative_prompt', 'seconds', 'resolution', 'aspect_ratio', 'width', 'height', 'seed', 'mode', 'scale', 'filename_prefix'],
  audio: ['text', 'voice_description', 'ref_audio', 'caption', 'lyrics', 'max_duration', 'seed', 'filename_prefix'],
};

const SAVE_RE = /^(Save|VHS_VideoCombine|SaveAnimatedWEBP)/;

function groupOf(kind) {
  return WORKFLOW_TASKS.find((t) => t.kind === kind)?.group || 'image';
}

function kindLabel(kind) {
  return WORKFLOW_TASKS.find((t) => t.kind === kind)?.label || kind;
}

const HW_LABELS = { nvidia: '英伟达', amd: 'AMD', runninghub: 'RunningHub' };
function hwLabel(hw) {
  return hw ? (HW_LABELS[hw] || hw) : '通用';
}

function nodeListOf(structure) {
  if (!structure || typeof structure !== 'object') return [];
  return Object.entries(structure).map(([id, n]) => ({
    id,
    classType: n?.class_type || '',
    title: n?._meta?.title || n?.class_type || String(id),
    inputs: Object.keys(n?.inputs || {}),
  }));
}

export default function WorkflowConfigPanel({ cfg, setCfg, workflows, mode, onReloadWorkflows }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const [viewId, setViewId] = useState(null);
  const preset = mode === 'runninghub' ? RUNNINGHUB_WORKFLOWS : (HW_PRESETS[mode] || {});
  const [taskFilter, setTaskFilter] = useState('all');
  const filteredTasks = taskFilter === 'all' ? WORKFLOW_TASKS : WORKFLOW_TASKS.filter((t) => t.group === taskFilter);
  const customWorkflows = workflows.filter((w) => w.spec?.builtin === false);

  // 工作流是否属于当前执行端：RunningHub 只认云端工作流（runninghub_* 内置，或 spec.hw='runninghub' 的自定义）；
  // 本地（英伟达 / AMD）只认本地工作流，且 spec.hw 为空（通用）或与当前硬件一致。
  // 自定义工作流在保存时会打上创建时的执行端，因此只会出现在对应类型下面。
  function isCompatible(w) {
    const sid = String(w.spec?.id || w.id || '');
    const hw = w.spec?.hw;
    if (mode === 'runninghub') return sid.startsWith('runninghub_') || hw === 'runninghub';
    if (sid.startsWith('runninghub_') || hw === 'runninghub') return false;
    return hw == null || hw === mode;
  }

  function optionsFor(kind) {
    // 内置视频工作流的 spec.kind 统一为 'r2v'，视频类槽位需同时列出 'r2v' 与自定义的细分 kind。
    const matchKinds = groupOf(kind) === 'video' ? ['r2v', kind] : [kind];
    return workflows
      .filter((w) => matchKinds.includes(w.kind) && isCompatible(w))
      .map((w) => ({ value: w.spec?.id || w.id, label: w.name }));
  }

  // 当前值若不属于当前执行端（切换 英伟达/AMD/RunningHub 后残留），回落到该端的预设，避免下拉显示空值。
  function currentId(kind) {
    const options = optionsFor(kind);
    const cur = cfg.workflows?.[kind];
    if (cur && options.some((o) => o.value === cur)) return cur;
    if (preset[kind]) return preset[kind];
    return options[0]?.value || '';
  }

  // 切换执行端后，把不属于当前端的配置值就地纠正为该端预设（仅内存，保存时落盘），
  // 保证「上面选哪种 ComfyUI 类型」和「下面卡片实际使用的工作流节点」一致。
  useEffect(() => {
    if (!workflows.length) return;
    const wf = cfg.workflows || {};
    const next = { ...wf };
    let changed = false;
    for (const t of WORKFLOW_TASKS) {
      const cur = next[t.kind];
      const ok = cur && optionsFor(t.kind).some((o) => o.value === cur);
      if (!ok && preset[t.kind] && next[t.kind] !== preset[t.kind]) {
        next[t.kind] = preset[t.kind];
        changed = true;
      }
    }
    if (changed) setCfg({ ...cfg, workflows: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows, mode]);

  function restore(kind) {
    if (preset[kind] === undefined) return;
    const label = WORKFLOW_TASKS.find((t) => t.kind === kind)?.label || kind;
    setCfg({ ...cfg, workflows: { ...(cfg.workflows || {}), [kind]: preset[kind] } });
    toast.success('已恢复「' + label + '」默认工作流');
  }

  async function remove(w) {
    try {
      await api.del('/api/workflows/' + encodeURIComponent(w.spec?.id || w.id));
      toast.success('已删除自定义工作流');
      onReloadWorkflows();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={taskFilter}
          onChange={setTaskFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'image', label: '图片' },
            { value: 'video', label: '视频' },
            { value: 'audio', label: '音频' },
          ]}
        />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setListOpen(true)}>
            <List size={13} /> 我的自定义工作流（{customWorkflows.length}）
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setEditing({ mode: 'create' })}>
            <Plus size={13} /> 新建自定义工作流
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filteredTasks.map((t) => {
          const id = currentId(t.kind);
          const wf = workflows.find((w) => (w.spec?.id || w.id) === id);
          const isCustom = wf?.spec?.builtin === false;
          return (
            <div key={t.kind} className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.02] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-[var(--fg)]">{t.label}</span>
                {isCustom ? <Badge tone="accent">自定义</Badge> : <Badge tone="neutral">默认</Badge>}
              </div>
              <Select value={id} onChange={(v) => setCfg({ ...cfg, workflows: { ...(cfg.workflows || {}), [t.kind]: v } })} items={optionsFor(t.kind)} placeholder="选择工作流" />
              <div className="flex items-center justify-end gap-1">
                {wf ? (
                  <Button variant="ghost" size="iconSm" title="查看节点" onClick={() => setViewId(wf.spec?.id || wf.id)}>
                    <Eye size={13} />
                  </Button>
                ) : null}
                <Button variant="ghost" size="iconSm" title="恢复默认" onClick={() => restore(t.kind)}>
                  <RotateCcw size={13} />
                </Button>
                {isCustom ? (
                  <>
                    <Button variant="ghost" size="iconSm" title="编辑" onClick={() => setEditing({ mode: 'edit', id: wf.spec?.id || wf.id })}>
                      <Pencil size={13} />
                    </Button>
                    <Button variant="ghost" size="iconSm" title="删除" onClick={() => remove(wf)}>
                      <Trash2 size={13} />
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {editing ? (
        <WorkflowEditorModal
          open
          backend={mode}
          onClose={() => setEditing(null)}
          initial={editing}
          onSaved={() => {
            setEditing(null);
            onReloadWorkflows();
          }}
        />
      ) : null}

      <WorkflowListModal
        open={listOpen}
        onClose={() => setListOpen(false)}
        workflows={customWorkflows}
        onCreate={() => {
          setListOpen(false);
          setEditing({ mode: 'create' });
        }}
        onEdit={(w) => {
          setListOpen(false);
          setEditing({ mode: 'edit', id: w.spec?.id || w.id });
        }}
        onView={(w) => setViewId(w.spec?.id || w.id)}
        onDelete={remove}
      />

      {viewId ? <WorkflowViewModal id={viewId} onClose={() => setViewId(null)} /> : null}
    </div>
  );
}

function WorkflowEditorModal({ open, onClose, initial, onSaved, backend = 'nvidia' }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('t2i');
  // 工作流归属的执行端（spec.hw）：默认跟随当前选中的 ComfyUI 类型，保存后只在该类型下可选。
  const [targetHw, setTargetHw] = useState(backend);
  const [jsonText, setJsonText] = useState('');
  const [structure, setStructure] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [roles, setRoles] = useState({});
  const [outputs, setOutputs] = useState([]);
  const [slots, setSlots] = useState([]);
  const [mediaMode, setMediaMode] = useState('slots');
  const [mediaTarget, setMediaTarget] = useState({
    targetNode: '',
    mediaField: '',
    typeField: '',
    fieldsByType: { image: '', audio: '', video: '', videoAudio: '' },
    reusePool: { image: '', audio: '', video: '' },
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const roleKeys = ROLES_BY_GROUP[groupOf(kind)] || [];
  const saveClasses = [...new Set(nodes.filter((n) => SAVE_RE.test(n.classType)).map((n) => n.classType))];

  useEffect(() => {
    if (!open) return;
    if (initial?.mode === 'edit' && initial.id) {
      api
        .get('/api/workflows/' + encodeURIComponent(initial.id))
        .then((w) => {
          setName(w.name || '');
          setKind(w.kind || 'custom');
          setTargetHw(w.spec?.hw || backend);
          setStructure(w.structure || null);
          setNodes(nodeListOf(w.structure));
          setRoles(w.spec?.roles || {});
          setOutputs(w.spec?.outputs || []);
          setSlots(w.spec?.media?.slots || []);
          const m = w.spec?.media || {};
          if (m.targetNode) {
            setMediaMode('target');
            setMediaTarget({
              targetNode: m.targetNode || '',
              mediaField: m.mediaField || '',
              typeField: m.typeField || '',
              fieldsByType: {
                image: m.fieldsByType?.image || '',
                audio: m.fieldsByType?.audio || '',
                video: m.fieldsByType?.video || '',
                videoAudio: m.fieldsByType?.videoAudio || '',
              },
              reusePool: {
                image: (m.reusePool?.image || []).join(','),
                audio: (m.reusePool?.audio || []).join(','),
                video: (m.reusePool?.video || []).join(','),
              },
            });
          } else {
            setMediaMode('slots');
          }
          setJsonText(w.structure ? JSON.stringify(w.structure, null, 2) : '');
        })
        .catch((e) => toast.error(e.message));
    } else {
      setTargetHw(backend);
    }
  }, [open, initial, backend]);

  function parseJson() {
    try {
      const s = JSON.parse(jsonText || '{}');
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('必须是工作流节点对象');
      setStructure(s);
      setNodes(nodeListOf(s));
      return s;
    } catch (e) {
      toast.error('JSON 解析失败：' + e.message);
      return null;
    }
  }

  function onPickFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setJsonText(String(reader.result || ''));
      toast.success('已读取 JSON 文件，可点击「自动分析」生成映射');
    };
    reader.onerror = () => toast.error('读取文件失败');
    reader.readAsText(file);
  }

  async function analyze() {
    const s = parseJson();
    if (!s) return;
    setAnalyzing(true);
    try {
      const r = await api.post('/api/workflows/analyze', { structure: s, kindGuess: kind, name });
      setRoles(r.roles || {});
      setOutputs(r.outputs || []);
      toast.success('已自动分析节点，请核对并补充映射');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  function setRole(role, patch) {
    setRoles((prev) => ({ ...prev, [role]: { ...(prev[role] || {}), ...patch } }));
  }

  function cleanRoles() {
    const out = {};
    for (const [k, v] of Object.entries(roles || {})) {
      if (v?.node && v?.field) out[k] = { node: v.node, field: v.field };
    }
    return out;
  }

  function setSlot(i, patch) {
    setSlots((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addSlot() {
    setSlots((prev) => [...prev, { node: '', field: '', type: 'image' }]);
  }
  function removeSlot(i) {
    setSlots((prev) => prev.filter((_, idx) => idx !== i));
  }
  function cleanSlots() {
    return slots.filter((s) => s.node && s.field);
  }

  function setMediaTargetField(patch) {
    setMediaTarget((prev) => ({ ...prev, ...patch }));
  }
  function setFieldByType(type, v) {
    setMediaTarget((prev) => ({ ...prev, fieldsByType: { ...prev.fieldsByType, [type]: v } }));
  }
  function setReusePool(type, v) {
    setMediaTarget((prev) => ({ ...prev, reusePool: { ...prev.reusePool, [type]: v } }));
  }
  function cleanMedia() {
    if (mediaMode === 'slots') {
      const sl = cleanSlots();
      return sl.length ? { media: { slots: sl } } : {};
    }
    const t = mediaTarget;
    const fieldsByType = {};
    for (const [k, v] of Object.entries(t.fieldsByType || {})) {
      if (v && String(v).trim()) fieldsByType[k] = String(v).trim();
    }
    const reusePool = {};
    for (const [k, v] of Object.entries(t.reusePool || {})) {
      const ids = String(v || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
      if (ids.length) reusePool[k] = ids;
    }
    const media = {};
    if (t.targetNode) media.targetNode = String(t.targetNode).trim();
    if (Object.keys(fieldsByType).length) {
      media.fieldsByType = fieldsByType;
    } else {
      if (t.mediaField && String(t.mediaField).trim()) media.mediaField = String(t.mediaField).trim();
      if (t.typeField && String(t.typeField).trim()) media.typeField = String(t.typeField).trim();
    }
    if (Object.keys(reusePool).length) media.reusePool = reusePool;
    return Object.keys(media).length ? { media } : {};
  }

  async function save() {
    const s = structure || parseJson();
    if (!s) return;
    if (!name.trim()) {
      toast.error('请填写工作流名称');
      return;
    }
    const spec = {
      kind,
      name: name.trim(),
      description: '',
      roles: cleanRoles(),
      outputs: outputs || [],
      ...cleanMedia(),
      hw: targetHw === 'generic' ? null : targetHw,
      builtin: false,
    };
    setSaving(true);
    try {
      if (initial?.mode === 'edit' && initial.id) {
        await api.put('/api/workflows/' + encodeURIComponent(initial.id), { structure: s, spec });
      } else {
        await api.post('/api/workflows', { name: name.trim(), kind, structure: s, spec });
      }
      toast.success('已保存自定义工作流');
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const nodeItems = nodes.map((n) => ({ value: n.id, label: n.title + '（' + n.id + '）' }));

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={initial?.mode === 'edit' ? '编辑工作流' : '新建自定义工作流'}
      description="粘贴 / 编辑 ComfyUI 工作流 JSON，配置输入节点与输出节点"
      size="xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={save}>
            保存工作流
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="工作流名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的自定义文生图" />
          </Field>
          <Field label="任务类型">
            <Select value={kind} onChange={setKind} items={WORKFLOW_TASKS.map((t) => ({ value: t.kind, label: t.label }))} />
          </Field>
          <Field label="适用执行端" hint="保存后只出现在该类型的工作流下拉里">
            <Select
              value={targetHw}
              onChange={setTargetHw}
              items={[
                { value: 'nvidia', label: '英伟达 · 原版工作流' },
                { value: 'amd', label: 'AMD · GGUF 量化适配' },
                { value: 'runninghub', label: 'RunningHub · 云端渲染' },
                { value: 'generic', label: '通用（英伟达 + AMD）' },
              ]}
            />
          </Field>
        </div>

        <Field
          label="工作流 JSON（ComfyUI 导出格式）"
          hint="可直接粘贴 API 格式 JSON，或点击「上传 JSON 文件」读取本地文件；随后点「自动分析」生成候选映射"
          action={
            <>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onPickFile} />
              <Button variant="ghost" size="xs" onClick={() => fileRef.current && fileRef.current.click()}>
                <FileUp size={12} /> 上传 JSON 文件
              </Button>
            </>
          }
        >
          <Textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={7} className="font-mono text-[11.5px]" placeholder='{"1": {"class_type": "KSampler", "inputs": {...}}, ...}' />
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" loading={analyzing} onClick={analyze}>
            <Wand2 size={13} /> 自动分析
          </Button>
          {nodes.length ? <span className="text-[11px] text-[var(--fg-3)]">已解析 {nodes.length} 个节点</span> : null}
        </div>

        {nodes.length ? (
          <>
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
              <div className="text-[12px] font-semibold text-[var(--fg)]">输入节点映射</div>
              {roleKeys.map((role) => {
                const cur = roles[role] || {};
                const node = nodes.find((n) => n.id === cur.node);
                const fieldItems = (node?.inputs || []).map((f) => ({ value: f, label: f }));
                return (
                  <div key={role} className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                    <span className="text-[12px] text-[var(--fg-2)]">{ROLE_LABELS[role] || role}</span>
                    <Select value={cur.node || ''} onChange={(v) => setRole(role, { node: v, field: '' })} items={nodeItems} placeholder="节点" />
                    <Select value={cur.field || ''} onChange={(v) => setRole(role, { field: v })} items={fieldItems} placeholder="字段" disabled={!cur.node} />
                  </div>
                );
              })}
            </div>

            {saveClasses.length ? (
              <div className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
                <div className="text-[12px] font-semibold text-[var(--fg)]">输出节点（读取产物）</div>
                <div className="flex flex-wrap gap-3">
                  {saveClasses.map((cls) => (
                    <Checkbox key={cls} checked={outputs.includes(cls)} onChange={(v) => setOutputs((prev) => (v ? [...new Set([...prev, cls])] : prev.filter((x) => x !== cls)))} label={cls} />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[12px] font-semibold text-[var(--fg)]">媒体 / 参考绑定（可选）</div>
                <Segmented
                  value={mediaMode}
                  onChange={setMediaMode}
                  size="xs"
                  options={[
                    { value: 'slots', label: '简单槽位' },
                    { value: 'target', label: '富绑定（全能参考）' },
                  ]}
                />
              </div>

              {mediaMode === 'slots' ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[var(--fg-3)]">图生视频 / 首尾帧 / 数字人：按顺序为每个槽位绑定一个媒体（类型 + 节点 + 字段）。</span>
                    <Button variant="ghost" size="xs" onClick={addSlot}>
                      <Plus size={12} /> 添加槽位
                    </Button>
                  </div>
                  {slots.length ? (
                    slots.map((s, i) => {
                      const node = nodes.find((n) => n.id === s.node);
                      const fieldItems = (node?.inputs || []).map((f) => ({ value: f, label: f }));
                      return (
                        <div key={i} className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
                          <Select value={s.type || 'image'} onChange={(v) => setSlot(i, { type: v })} items={[{ value: 'image', label: '图片' }, { value: 'audio', label: '音频' }, { value: 'video', label: '视频' }]} />
                          <Select value={s.node || ''} onChange={(v) => setSlot(i, { node: v, field: '' })} items={nodeItems} placeholder="节点" />
                          <Select value={s.field || ''} onChange={(v) => setSlot(i, { field: v })} items={fieldItems} placeholder="字段" disabled={!s.node} />
                          <Button variant="ghost" size="iconSm" onClick={() => removeSlot(i)}>
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      );
                    })
                  ) : (
                    <p className="m-0 text-[11px] text-[var(--fg-3)]">不填则按模板默认。</p>
                  )}
                </>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="媒体承载节点（targetNode）">
                      <Select value={mediaTarget.targetNode} onChange={(v) => setMediaTargetField({ targetNode: v })} items={nodeItems} placeholder="选择节点" />
                    </Field>
                    <Field label="复用图片 loader 节点（reusePool.image，逗号分隔）">
                      <Input value={mediaTarget.reusePool.image} onChange={(e) => setReusePool('image', e.target.value)} placeholder="如 20,21" />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="图片字段前缀（fieldsByType.image）">
                      <Input value={mediaTarget.fieldsByType.image} onChange={(e) => setFieldByType('image', e.target.value)} placeholder="如 ref_images.ref_image_" />
                    </Field>
                    <Field label="音频字段前缀（fieldsByType.audio）">
                      <Input value={mediaTarget.fieldsByType.audio} onChange={(e) => setFieldByType('audio', e.target.value)} placeholder="如 ref_audios.ref_audio_" />
                    </Field>
                    <Field label="视频字段前缀（fieldsByType.video）">
                      <Input value={mediaTarget.fieldsByType.video} onChange={(e) => setFieldByType('video', e.target.value)} placeholder="如 ref_videos.ref_video_" />
                    </Field>
                    <Field label="视频音轨前缀（fieldsByType.videoAudio）">
                      <Input value={mediaTarget.fieldsByType.videoAudio} onChange={(e) => setFieldByType('videoAudio', e.target.value)} placeholder="如 ref_video_audios.ref_video_audio_" />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="媒体字段前缀（mediaField，未用 fieldsByType 时）">
                      <Input value={mediaTarget.mediaField} onChange={(e) => setMediaTargetField({ mediaField: e.target.value })} placeholder="如 media_" />
                    </Field>
                    <Field label="媒体类型字段前缀（typeField）">
                      <Input value={mediaTarget.typeField} onChange={(e) => setMediaTargetField({ typeField: e.target.value })} placeholder="如 media_type_" />
                    </Field>
                  </div>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function WorkflowListModal({ open, onClose, workflows, onCreate, onEdit, onView, onDelete }) {
  const [filter, setFilter] = useState('all');
  const filtered = filter === 'all' ? workflows : workflows.filter((w) => groupOf(w.kind) === filter);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="我的自定义工作流"
      description="管理已提交的自定义工作流，支持增 / 删 / 改 / 查；默认工作流不在此列出"
      size="2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" size="sm" onClick={onCreate}>
            <Plus size={13} /> 新建工作流
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'image', label: '图片' },
            { value: 'video', label: '视频' },
            { value: 'audio', label: '音频' },
          ]}
        />

        {filtered.length ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((w) => (
              <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.02] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-medium text-[var(--fg)]">{w.name}</span>
                  <Badge tone="accent">自定义</Badge>
                </div>
                <span className="text-[11px] text-[var(--fg-3)]">{kindLabel(w.kind)} · {hwLabel(w.spec?.hw)}</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="iconSm" title="查看" onClick={() => onView(w)}>
                    <Eye size={13} />
                  </Button>
                  <Button variant="ghost" size="iconSm" title="编辑" onClick={() => onEdit(w)}>
                    <Pencil size={13} />
                  </Button>
                  <Button variant="ghost" size="iconSm" title="删除" onClick={() => onDelete(w)}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-[12px] text-[var(--fg-3)]">还没有自定义工作流，点下方「新建工作流」添加。</p>
        )}
      </div>
    </Modal>
  );
}

function WorkflowViewModal({ id, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id) return;
    setData(null);
    setErr('');
    api
      .get('/api/workflows/' + encodeURIComponent(id))
      .then(setData)
      .catch((e) => setErr(e.message || '加载失败'));
  }, [id]);

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={data?.name || '查看工作流'}
      description={data ? kindLabel(data.kind) + ' · ' + hwLabel(data.spec?.hw) + ' · ' + (data.sourceFile || '') : '加载中…'}
      size="lg"
      footer={<Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>}
    >
      {err ? (
        <p className="m-0 text-[12px] text-[var(--danger)]">{err}</p>
      ) : !data ? (
        <p className="m-0 text-[12px] text-[var(--fg-3)]">加载中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="节点列表">
            {data.summary?.nodes?.length ? (
              <div className="flex max-h-64 flex-col gap-1 overflow-auto rounded-xl border border-[var(--line)] bg-white/[0.02] p-2">
                {data.summary.nodes.map((n) => (
                  <div key={n.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px] hover:bg-white/[0.03]">
                    <span className="shrink-0 font-mono text-[var(--accent)]">{n.id}</span>
                    <span className="shrink-0 text-[var(--fg-2)]">{n.classType || '—'}</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--fg-3)]">{n.title ? '· ' + n.title : ''}</span>
                    <span className="shrink-0 text-[var(--fg-4)]">{(n.inputs || []).length} 输入</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-[var(--fg-3)]">—</div>
            )}
          </Field>
          <Field label="输入节点映射（roles）">
            <pre className="m-0 overflow-x-auto rounded-xl border border-[var(--line)] bg-white/[0.02] p-3 font-mono text-[11px] leading-relaxed text-[var(--fg-2)]">{JSON.stringify(data.spec?.roles || {}, null, 2)}</pre>
          </Field>
          <Field label="媒体 / 参考绑定（media）">
            <pre className="m-0 overflow-x-auto rounded-xl border border-[var(--line)] bg-white/[0.02] p-3 font-mono text-[11px] leading-relaxed text-[var(--fg-2)]">{JSON.stringify(data.spec?.media || {}, null, 2)}</pre>
          </Field>
          <Field label="输出节点（outputs）">
            <div className="text-[12px] text-[var(--fg-2)]">{(data.spec?.outputs || []).join('、') || '—'}</div>
          </Field>
          <Field label="工作流 JSON">
            <pre className="m-0 max-h-80 overflow-auto rounded-xl border border-[var(--line)] bg-white/[0.02] p-3 font-mono text-[11px] leading-relaxed text-[var(--fg-2)]">{JSON.stringify(data.structure, null, 2)}</pre>
          </Field>
        </div>
      )}
    </Modal>
  );
}
