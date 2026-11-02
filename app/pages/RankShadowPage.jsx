'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 「无限・秩影」工作台：lemo-opuscar 风格卡片（分类筛选）→ 使用风格 → 上传素材 + 提示词 → 生成任务 → 记录管理。
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Card, CardBody, Button, Chip, Input, Textarea, Spinner, Checkbox, Select, SelectItem, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useAutoProject, useJobs } from './simpleStudio';
import { fileUrl, statusColor, selectKeys, pickKey } from './shared';

const STATUS_LABEL = { pending: '排队中', generating: '生成中', running: '生成中', done: '完成', failed: '失败' };
const MEDIA_KINDS = [
  ['image', '图片', 'image/*'],
  ['audio', '音频', 'audio/*'],
  ['video', '视频', 'video/*'],
];

function statusText(s) { return STATUS_LABEL[s] || s || '排队中'; }

export default function RankShadowPage() {
  const toast = useToast();
  const currentId = useAutoProject('opuscar', '无限・秩影');
  const { jobs, reloadJobs } = useJobs(currentId);

  // —— 风格库 ——
  const [styles, setStyles] = useState([]);
  const [catFilter, setCatFilter] = useState('全部');
  const [selectedStyle, setSelectedStyle] = useState(null);

  // —— 创建 ——
  const [prompt, setPrompt] = useState('');
  const [materials, setMaterials] = useState([]); // { type, filename, name }
  const [busy, setBusy] = useState(false);

  // —— 记录 ——
  const [records, setRecords] = useState([]);
  const [kw, setKw] = useState('');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [selected, setSelected] = useState(new Set());

  // —— 编辑弹窗 ——
  const [editRecord, setEditRecord] = useState(null);
  const [editName, setEditName] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editStyleSlug, setEditStyleSlug] = useState('');
  const [editMaterials, setEditMaterials] = useState([]);
  const [editBusy, setEditBusy] = useState(false);

  const imgRef = useRef(null); const audRef = useRef(null); const vidRef = useRef(null);
  const editRef = useRef(null);

  useEffect(() => { api.get('/api/opuscar/styles').then(setStyles).catch(() => setStyles([])); }, []);

  const loadRecords = useCallback(() => {
    if (!currentId) return;
    api.get('/api/projects/' + currentId + '/opuscar').then(setRecords).catch(() => setRecords([]));
  }, [currentId]);
  useEffect(() => { loadRecords(); const t = setInterval(loadRecords, 4000); return () => clearInterval(t); }, [loadRecords]);

  const cats = useMemo(() => ['全部', ...Array.from(new Set(styles.map((s) => s.cat)))], [styles]);
  const filteredStyles = useMemo(() => (catFilter === '全部' ? styles : styles.filter((s) => s.cat === catFilter)), [styles, catFilter]);

  const filteredRecords = useMemo(() => records.filter((r) => {
    const nm = (r.name || '').toLowerCase();
    const pp = (r.prompt || '').toLowerCase();
    const k = kw.toLowerCase();
    if (k && !nm.includes(k) && !pp.includes(k)) return false;
    if (statusFilter !== '全部') {
      const st = r.status;
      if (statusFilter === '生成中') { if (!(st === 'generating' || st === 'running' || st === 'pending')) return false; }
      else if (statusFilter === '完成' && st !== 'done') return false;
      else if (statusFilter === '失败' && st !== 'failed') return false;
    }
    return true;
  }), [records, kw, statusFilter]);

  async function uploadOne(file) {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('/api/projects/' + currentId + '/media', { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('上传失败 HTTP ' + res.status));
    return j; // { path, kind }
  }

  async function onFiles(e, kind) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    if (!currentId) { toast.error('项目初始化中，请稍候'); return; }
    try {
      const added = [];
      for (const f of files) added.push({ type: kind, filename: (await uploadOne(f)).path, name: f.name });
      setMaterials((p) => [...p, ...added]);
    } catch (err) { toast.error(err.message); }
  }
  function removeMaterial(i) { setMaterials((p) => p.filter((_, idx) => idx !== i)); }

  function useStyle(s) {
    setSelectedStyle(s);
    setCatFilter(s.cat || '全部');
    document.getElementById('opuscar-create')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function create() {
    if (!currentId) { toast.error('项目初始化中，请稍候'); return; }
    if (!selectedStyle) { toast.error('请先在风格库点击「使用风格」选择风格'); return; }
    if (!prompt.trim()) { toast.error('请输入提示词'); return; }
    setBusy(true);
    try {
      await api.post('/api/projects/' + currentId + '/opuscar', {
        style_slug: selectedStyle.slug,
        prompt: prompt.trim(),
        references: materials,
      });
      toast.success('已创建生成任务');
      setPrompt('');
      setMaterials([]);
      loadRecords(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function regenerate(r) {
    if (!currentId) return;
    setBusy(true);
    try {
      const p = r.params || {};
      await api.post('/api/projects/' + currentId + '/opuscar', {
        asset_id: r.id,
        style_slug: p.style_slug,
        prompt: r.prompt || '',
        references: p.references || [],
      });
      toast.success('已重新生成');
      loadRecords(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function delOne(r) {
    if (!currentId) return;
    try {
      await api.del('/api/projects/' + currentId + '/opuscar/' + r.id);
      toast.success('已删除');
      loadRecords(); reloadJobs();
    } catch (e) { toast.error(e.message); }
  }

  function toggleSelect(id) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    const ids = filteredRecords.map((r) => r.id);
    setSelected((prev) => (prev.size === ids.length && ids.length ? new Set() : new Set(ids)));
  }

  async function batchDelete() {
    if (!currentId || !selected.size) return;
    try {
      const r = await api.post('/api/projects/' + currentId + '/opuscar/batch-delete', { ids: Array.from(selected) });
      const d = (r.deleted || []).length; const s = (r.skipped || []).length;
      toast.success('已删除 ' + d + ' 条' + (s ? '，跳过 ' + s + ' 条（生成中）' : ''));
      setSelected(new Set());
      loadRecords(); reloadJobs();
    } catch (e) { toast.error(e.message); }
  }

  function openEdit(r) {
    setEditRecord(r);
    setEditName(r.name || '');
    setEditPrompt(r.prompt || '');
    setEditStyleSlug((r.params || {}).style_slug || '');
    setEditMaterials((r.params || {}).references || []);
  }

  async function onEditFiles(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    if (!currentId) { toast.error('项目初始化中，请稍候'); return; }
    try {
      const added = [];
      for (const f of files) {
        const j = await uploadOne(f);
        const kind = j.kind === 'audio' || j.kind === 'video' ? j.kind : 'image';
        added.push({ type: kind, filename: j.path, name: f.name });
      }
      setEditMaterials((p) => [...p, ...added]);
    } catch (err) { toast.error(err.message); }
  }
  function removeEditMaterial(i) { setEditMaterials((p) => p.filter((_, idx) => idx !== i)); }

  async function saveEdit() {
    if (!currentId || !editRecord) return;
    setEditBusy(true);
    try {
      await api.patch('/api/projects/' + currentId + '/opuscar/' + editRecord.id, {
        name: editName,
        prompt: editPrompt,
        style_slug: editStyleSlug,
        references: editMaterials,
      });
      toast.success('已保存');
      setEditRecord(null);
      loadRecords(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setEditBusy(false); }
  }

  const activeJobIds = useMemo(() => new Set((jobs || []).filter((j) => j.status === 'running' || j.status === 'queued').map((j) => (j.checkpoint && j.checkpoint.subject) || '')), [jobs]);

  return (
    <div className="flex flex-col gap-4">
      {/* ===== 风格库 ===== */}
      <Card shadow="none" className="border border-default-200">
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">风格库（lemo-opuscar）</h2>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {cats.map((c) => (
              <Button key={c} size="sm" variant={catFilter === c ? 'solid' : 'flat'} color={catFilter === c ? 'primary' : 'default'} onPress={() => setCatFilter(c)}>{c}</Button>
            ))}
          </div>
          {!styles.length && <div className="muted text-sm">正在加载风格…</div>}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
            {filteredStyles.map((s) => (
              <div key={s.slug} className="border border-default-200 rounded-xl overflow-hidden flex flex-col bg-default-50">
                <div className="aspect-[4/3] bg-black flex items-center justify-center overflow-hidden">
                  <img src={'/api/opuscar/style-image?slug=' + s.slug} alt={s.cn || s.slug} className="w-full h-full object-cover" loading="lazy" />
                </div>
                <div className="p-2 flex flex-col gap-1 flex-1">
                  <div className="text-sm font-medium leading-tight">{s.cn || s.slug}</div>
                  <div className="muted text-xs leading-tight">{s.en} · {s.cat}</div>
                  <div className="flex-1" />
                  <Button size="sm" color={selectedStyle && selectedStyle.slug === s.slug ? 'success' : 'primary'} variant={selectedStyle && selectedStyle.slug === s.slug ? 'flat' : 'solid'} onPress={() => useStyle(s)}>
                    {selectedStyle && selectedStyle.slug === s.slug ? '已选风格' : '使用风格'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* ===== 创建生成 ===== */}
      <Card shadow="none" className="border border-default-200" id="opuscar-create">
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">创建生成</h2>
          <div className="row items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="muted">当前风格</span>
            {selectedStyle ? (
              <Chip size="sm" variant="flat" color="primary">{selectedStyle.cn || selectedStyle.slug}（{selectedStyle.cat}）</Chip>
            ) : <span className="muted text-sm">未选择（请在上方风格库点击「使用风格」）</span>}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {MEDIA_KINDS.map(([kind, label]) => (
              <Button key={kind} size="sm" variant="flat" onPress={() => kind === 'image' ? imgRef.current?.click() : kind === 'audio' ? audRef.current?.click() : vidRef.current?.click()}>
                ＋ {label}素材（{materials.filter((m) => m.type === kind).length}）
              </Button>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>素材作为「剪辑与纪实」类风格的真实素材来源，或其余风格的参考/风格锚点</span>
          </div>
          <input ref={imgRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e, 'image')} />
          <input ref={audRef} type="file" accept="audio/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e, 'audio')} />
          <input ref={vidRef} type="file" accept="video/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e, 'video')} />
          {materials.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {materials.map((m, i) => (
                <Chip key={i} size="sm" variant="flat" onClose={() => removeMaterial(i)}>[{m.type}] {m.name}</Chip>
              ))}
            </div>
          )}
          <Textarea size="sm" placeholder="输入提示词，描述你想创作的短片主题/内容/风格方向" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div>
            <Button color="primary" isDisabled={busy || !currentId} onPress={create}>{busy ? '提交中…' : '创建生成任务'}</Button>
          </div>
        </CardBody>
      </Card>

      {/* ===== 生成记录 ===== */}
      <Card shadow="none" className="border border-default-200">
        <CardBody className="gap-3">
          <div className="row justify-between items-center" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 className="text-lg font-semibold m-0">生成记录（{records.length}）</h2>
            <div className="row items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Input size="sm" className="w-52" placeholder="搜索名称/提示词" value={kw} onChange={(e) => setKw(e.target.value)} />
              <Select size="sm" className="w-28" aria-label="状态筛选" selectedKeys={selectKeys(statusFilter)} onSelectionChange={(k) => setStatusFilter(pickKey(k) || '全部')}>
                {['全部', '生成中', '完成', '失败'].map((s) => <SelectItem key={s}>{s}</SelectItem>)}
              </Select>
              <Button size="sm" variant="flat" isDisabled={!selected.size} onPress={batchDelete}>批量删除（{selected.size}）</Button>
            </div>
          </div>

          {!filteredRecords.length && <div className="muted text-sm">暂无记录</div>}
          <div className="flex flex-col gap-2">
            {filteredRecords.map((r) => {
              const p = r.params || {};
              const running = activeJobIds.has(r.id);
              return (
                <div key={r.id} className="border border-default-200 rounded-xl p-2 flex items-center gap-3 bg-default-50">
                  <Checkbox isSelected={selected.has(r.id)} onValueChange={() => toggleSelect(r.id)} aria-label="选择" />
                  <div className="w-28 h-16 bg-black rounded overflow-hidden shrink-0 flex items-center justify-center">
                    {r.video_path ? (
                      <video src={fileUrl(currentId, r.video_path)} className="w-full h-full object-cover" muted playsInline />
                    ) : (
                      <span className="muted text-xs">{running ? '生成中…' : '无成片'}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{r.name || '（未命名）'}</div>
                    <div className="muted text-xs truncate">风格：{p.style_cn || p.style_slug || '—'} · {p.cat || ''}</div>
                    <div className="muted text-xs truncate">{r.prompt || '（无提示词）'}</div>
                  </div>
                  <Chip size="sm" variant="flat" color={statusColor(r.status)}>{statusText(r.status)}</Chip>
                  <div className="muted text-xs shrink-0">{r.created_at ? new Date(r.created_at).toLocaleString() : ''}</div>
                  <div className="row shrink-0" style={{ gap: 6 }}>
                    {r.video_path && r.status === 'done' && <a className="text-sm text-primary hover:underline" href={fileUrl(currentId, r.video_path)} target="_blank" rel="noreferrer">下载</a>}
                    <Button size="sm" variant="flat" onPress={() => openEdit(r)}>编辑</Button>
                    <Button size="sm" variant="flat" color="primary" isDisabled={running || busy} onPress={() => regenerate(r)}>重新生成</Button>
                    <Button size="sm" variant="light" color="danger" isDisabled={running} onPress={() => delOne(r)}>删除</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {/* ===== 编辑弹窗 ===== */}
      <Modal isOpen={!!editRecord} backdrop="blur" onClose={() => setEditRecord(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">编辑记录</h2></ModalHeader>
              <ModalBody className="gap-3">
                <Input size="sm" label="名称" value={editName} onChange={(e) => setEditName(e.target.value)} />
                <Select size="sm" label="风格" selectedKeys={selectKeys(editStyleSlug)} onSelectionChange={(k) => setEditStyleSlug(pickKey(k))}>
                  {styles.map((s) => <SelectItem key={s.slug}>{s.cn || s.slug}（{s.cat}）</SelectItem>)}
                </Select>
                <Textarea size="sm" label="提示词" value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
                <div>
                  <div className="text-sm mb-1">素材</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {editMaterials.map((m, i) => (
                      <Chip key={i} size="sm" variant="flat" onClose={() => removeEditMaterial(i)}>[{m.type}] {m.name || m.filename}</Chip>
                    ))}
                  </div>
                  <Button size="sm" variant="flat" onPress={() => editRef.current && editRef.current.click()}>＋ 添加素材</Button>
                  <input ref={editRef} type="file" multiple style={{ display: 'none' }} onChange={onEditFiles} />
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setEditRecord(null)}>取消</Button>
                <Button size="sm" color="primary" isDisabled={editBusy} onPress={saveEdit}>{editBusy ? '保存中…' : '保存'}</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
