'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Button, Input, Select, SelectItem, Textarea, Card, CardBody, Tabs, Tab, Chip, Modal, ModalContent, ModalBody } from '@heroui/react';
import { api } from '../api-client.js';
import { CATEGORIES, fileUrl, selectKeys, pickKey, statusColor } from './shared';
import { useToast } from '../toast';

// ============ 资产库 ============
export default function AssetsTab({ projectId, running = false }) {
  const toast = useToast();
  const [assets, setAssets] = useState([]);
  const [cat, setCat] = useState('');
  const [form, setForm] = useState({ category: 'character', name: '', description: '' });
  const [edit, setEdit] = useState(null);
  const [uploadTarget, setUploadTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [outfits, setOutfits] = useState({});
  const [ages, setAges] = useState({});
  const fileRef = useRef(null);
  const load = useCallback(() => api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch((e) => toast.error(e.message)), [projectId]);
  useEffect(() => { load(); }, [load]);
  const shownAssets = cat ? assets.filter((a) => a.category === cat) : assets;
  const costumesOfChar = (charId) => assets.filter((a) => a.category === 'costume' && a.parent_id === charId);
  const agesOfChar = (charId) => assets.filter((a) => a.category === 'age' && a.parent_id === charId);

  async function designVoice(a) {
    try { await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/design-voice'); toast.success('已提交音色设计，稍后在「运行日志」查看进度'); load(); } catch (e) { toast.error(e.message); }
  }
  function pickUpload(a) { setUploadTarget(a.id); if (fileRef.current) fileRef.current.click(); }
  async function doUpload(aid, file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/projects/' + projectId + '/assets/' + aid + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => { return {}; });
        throw new Error(j.error || ('HTTP ' + res.status));
      }
      load();
    } catch (e) { toast.error('上传失败：' + e.message); }
  }

  async function create() {
    try { await api.post('/api/projects/' + projectId + '/assets', form); setForm({ ...form, name: '', description: '' }); load(); } catch (e) { toast.error(e.message); }
  }
  async function del(a) {
    if (!(await toast.confirm('删除资产「' + a.name + '」？此操作不可逆。', { danger: true }))) return;
    try { await api.del('/api/projects/' + projectId + '/assets/' + a.id); toast.success('已删除「' + a.name + '」'); load(); } catch (e) { toast.error(e.message); }
  }
  async function regenImage(a, mode) {
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/generate', { mode: mode || 't2i' });
      toast.success((mode === 'i2i' ? '已提交重新生成（图生图，基于现有图）' : '已提交生成图片') + '，稍后在「运行日志」查看进度');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function changeOutfit(a) {
    const outfit = await toast.prompt('输入服装描述（如：冬季红色斗篷 / 校园制服 / 战斗铠甲）', { defaultValue: outfits[a.id] || '', placeholder: '服装描述' });
    if (!outfit) return;
    setOutfits({ ...outfits, [a.id]: outfit });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-outfit', { outfit });
      toast.success('已提交换装（图生图），稍后在「运行日志」查看进度');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function changeAge(a) {
    const age = await toast.prompt('输入年龄/时期描述（如：年轻时 / 中年时 / 老年时）', { defaultValue: ages[a.id] || '', placeholder: '年龄/时期描述' });
    if (!age) return;
    setAges({ ...ages, [a.id]: age });
    try {
      await api.post('/api/projects/' + projectId + '/assets/' + a.id + '/change-age', { age });
      toast.success('已提交年龄变化（图生图），稍后在「运行日志」查看进度');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function saveEdit() {
    try { await api.patch('/api/projects/' + projectId + '/assets/' + edit.id, { name: edit.name, description: edit.description, prompt: edit.prompt }); toast.success('已保存'); setEdit(null); load(); } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">新建资产</h2>
          <div className="row">
            <Select size="sm" className="w-32" aria-label="资产分类" selectedKeys={selectKeys(form.category)} onSelectionChange={(k) => setForm({ ...form, category: pickKey(k) })}>
              {CATEGORIES.map(([k, l]) => <SelectItem key={k}>{l}</SelectItem>)}
            </Select>
            <Input size="sm" className="w-40" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input size="sm" className="w-72" placeholder="描述（可选，Agent 会自动补全）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <Button size="sm" color="primary" isDisabled={!form.name} onPress={create}>添加</Button>
          </div>
          <p className="muted">素材库为全项目共用、跨章节复用；角色/场景/道具图可由 Agent 生成，也可点「生成图」单独补图。</p>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="gap-3">
          <Tabs aria-label="资产分类" size="sm" variant="light" selectedKey={cat || 'all'} onSelectionChange={(k) => setCat(k === 'all' ? '' : String(k))}>
            <Tab key="all" title="全部" />
            {CATEGORIES.map(([k, l]) => <Tab key={k} title={l} />)}
          </Tabs>
          <div className="grid">
            {shownAssets.map((a) => (
              <div key={a.id}>
                {a.video_path
                  ? <video className="thumb" controls src={fileUrl(projectId, a.video_path)} />
                  : a.image_path
                    ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={() => setPreview(a)} style={{ cursor: 'zoom-in' }} title="点击预览大图" />
                    : (a.audio_path || a.voice_ref)
                      ? <div className="thumb" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, aspectRatio: '1 / 1' }}>
                          <div className="muted">{a.category}</div>
                          <audio controls src={fileUrl(projectId, a.audio_path || a.voice_ref)} style={{ width: '92%' }} />
                        </div>
                      : <div className="thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', aspectRatio: '1 / 1' }}>{a.category}</div>}
                {edit && edit.id === a.id ? (
                  <div className="flex flex-col gap-1 mt-1.5">
                    <Input size="sm" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="名称" />
                    <Input size="sm" value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="描述" />
                    <Textarea size="sm" value={edit.prompt || ''} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} placeholder="提示词（可选，用于生成/重新生成）" minRows={2} />
                    <div className="row mt-1">
                      <Button size="sm" color="primary" onPress={saveEdit}>保存</Button>
                      <Button size="sm" variant="flat" onPress={() => setEdit(null)}>取消</Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 6 }}>
                    <b>{a.name}</b>
                    <div className="muted">{a.category}{(a.category === 'costume' || a.category === 'age') && a.parent_id ? ' · 来自「' + (assets.find((x) => x.id === a.parent_id)?.name || a.parent_id) + '」' : ''}</div>
                    <Chip size="sm" variant="flat" color={statusColor(a.status)}>{a.status}</Chip>
                    {(a.voice_ref || a.audio_path) && (a.image_path || a.video_path) && (
                      <>
                        <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>音色试听</div>
                        <audio controls src={fileUrl(projectId, a.voice_ref || a.audio_path)} style={{ width: '100%', height: 32 }} title="人物参考音色试听" />
                      </>
                    )}
                    <div className="row" style={{ marginTop: 6, gap: 4 }}>
                      {['character', 'scene', 'prop', 'other'].includes(a.category) && (
                        <>
                          <Button size="sm" variant="flat" isDisabled={running} onPress={() => regenImage(a, 't2i')}>生成图</Button>
                          {a.image_path && <Button size="sm" variant="flat" isDisabled={running} onPress={() => regenImage(a, 'i2i')} title="基于现有图重新生成（图生图，保持一致性）">重新生成</Button>}
                        </>
                      )}
                      {a.category === 'character' && a.image_path && <Button size="sm" variant="flat" isDisabled={running} onPress={() => changeOutfit(a)} title="基于角色图用图生图生成一套新服装">换装</Button>}
                      {a.category === 'character' && a.image_path && <Button size="sm" variant="flat" isDisabled={running} onPress={() => changeAge(a)} title="基于角色图用图生图生成同一人物的不同年龄/时期样貌">年龄</Button>}
                      {(a.category === 'character' || a.category === 'voice') && <Button size="sm" variant="flat" isDisabled={running} onPress={() => designVoice(a)}>设计音色</Button>}
                      <Button size="sm" variant="flat" onPress={() => pickUpload(a)}>上传/替换</Button>
                      <Button size="sm" variant="flat" onPress={() => setEdit({ id: a.id, name: a.name, description: a.description || '', prompt: a.prompt || '' })}>编辑</Button>
                      <Button size="sm" variant="flat" color="danger" onPress={() => del(a)}>删除</Button>
                    </div>
                    {a.category === 'character' && costumesOfChar(a.id).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div className="muted" style={{ marginBottom: 4 }}>服装（{costumesOfChar(a.id).length} 套）</div>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                          {costumesOfChar(a.id).map((c) => (
                            <div key={c.id} style={{ textAlign: 'center', width: 56 }}>
                              {c.image_path
                                ? <img src={fileUrl(projectId, c.image_path)} onClick={() => setPreview(c)} style={{ width: 52, height: 52, objectFit: 'cover', cursor: 'zoom-in', borderRadius: 4 }} title={c.name + '（点击预览）'} />
                                : <div className="thumb" style={{ width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', aspectRatio: '1 / 1' }}>服装</div>}
                              <div className="muted" style={{ fontSize: 10, wordBreak: 'break-all', lineHeight: 1.2 }}>{c.name.replace(a.name + '-', '')}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {a.category === 'character' && agesOfChar(a.id).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div className="muted" style={{ marginBottom: 4 }}>年龄/时期（{agesOfChar(a.id).length} 个）</div>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                          {agesOfChar(a.id).map((g) => (
                            <div key={g.id} style={{ textAlign: 'center', width: 56 }}>
                              {g.image_path
                                ? <img src={fileUrl(projectId, g.image_path)} onClick={() => setPreview(g)} style={{ width: 52, height: 52, objectFit: 'cover', cursor: 'zoom-in', borderRadius: 4 }} title={g.name + '（点击预览）'} />
                                : <div className="thumb" style={{ width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', aspectRatio: '1 / 1' }}>年龄</div>}
                              <div className="muted" style={{ fontSize: 10, wordBreak: 'break-all', lineHeight: 1.2 }}>{g.name.replace(a.name + '-', '')}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {!assets.length && <p className="muted">暂无资产</p>}
        </CardBody>
      </Card>

      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f && uploadTarget) doUpload(uploadTarget, f); e.target.value = ''; setUploadTarget(null); }} />

      <Modal isOpen={!!preview} size="3xl" backdrop="blur" onClose={() => setPreview(null)}>
        <ModalContent>
          {() => (
            <ModalBody className="items-center py-6">
              {preview && <img src={fileUrl(projectId, preview.image_path)} className="max-w-full max-h-[78vh] rounded-md" />}
              <div className="mt-2"><b>{preview && preview.name}</b> <span className="muted">{preview && preview.category}</span></div>
            </ModalBody>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}