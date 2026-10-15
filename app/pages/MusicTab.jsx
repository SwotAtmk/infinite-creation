'use client';
import { useEffect, useState, useCallback } from 'react';
import { Button, Input, Textarea, Checkbox, Card, CardBody, Chip, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { fileUrl, statusColor } from './shared';
import { useToast } from '../toast';
import LoadingOverlay from './LoadingOverlay';

const STATUS_LABEL = { pending: '待生成', generating: '生成中', done: '完成', failed: '生成失败' };

// ============ 背景音乐库 ============
export default function MusicTab({ projectId, chapters, running, onRefresh }) {
  const toast = useToast();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [genOpen, setGenOpen] = useState(false);
  const [genAssetId, setGenAssetId] = useState(null); // null=新建，否则编辑/重生成该资产
  const [genForm, setGenForm] = useState({ name: '', caption: '', lyrics: '', max_duration: '' });
  const [detailAsset, setDetailAsset] = useState(null);
  const [applyTarget, setApplyTarget] = useState(null);
  const [applySelection, setApplySelection] = useState([]);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => api.get('/api/projects/' + projectId + '/assets?category=music').then(setAssets).catch((e) => toast.error(e.message)), [projectId]);
  // 生成期间定时拉取，实时反映每条音乐「生成中→完成/失败」的状态变化
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
    setGenForm({
      name: a.name || '',
      caption: a.prompt || '',
      lyrics: a.lyrics || '',
      max_duration: a.max_duration ? String(a.max_duration) : '',
    });
    setGenOpen(true);
  }

  async function generateMusic() {
    if (!genForm.caption.trim()) { toast.error('请填写音乐描述 caption'); return; }
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
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }

  async function retryGenerate(a) {
    setBusy('正在重新生成背景音乐…');
    try {
      await api.post('/api/projects/' + projectId + '/music', { asset_id: a.id });
      toast.success('已重新提交背景音乐生成');
      load();
      onRefresh && onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }

  function openApply(assetId) {
    setApplyTarget(assetId);
    setApplySelection([]);
  }
  function toggleChapter(title) {
    setApplySelection((prev) => (prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]));
  }
  async function applyMusic() {
    if (!applyTarget || !applySelection.length) return;
    setBusy('正在应用背景音乐并合成成片…');
    try {
      await api.post('/api/projects/' + projectId + '/music/apply', { music_id: applyTarget, chapters: applySelection });
      toast.success('已应用背景音乐并重新合成成片，可到「🎞 成片」页预览');
      setApplyTarget(null);
      setApplySelection([]);
      load();
      onRefresh && onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }

  if (loading) {
    return (
      <Card>
        <CardBody className="flex-row items-center justify-center gap-2.5 py-10">
          <Spinner size="sm" />
          <span className="muted">背景音乐数据加载中…</span>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 className="text-lg font-semibold m-0">背景音乐</h2>
            <Button size="sm" color="primary" isDisabled={running} onPress={openNew}>＋ 生成背景音乐</Button>
            <span className="muted" style={{ fontSize: 12 }}>纯音乐/带歌词均可；点某条音乐的「应用到」选择多个已生成的章节合成最终视频。</span>
          </div>

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {assets.map((a) => {
              const st = a.status;
              const isGenerating = st === 'generating';
              return (
                <Card key={a.id} shadow="none" className="border border-default-200 bg-default-50">
                  <CardBody className="gap-2" style={{ justifyContent: 'space-between' }}>
                    <div className="row justify-between" style={{ alignItems: 'center' }}>
                      <b style={{ wordBreak: 'break-all' }}>{a.name}</b>
                      <Chip size="sm" variant="flat" color={statusColor(st)}>{STATUS_LABEL[st] || st}</Chip>
                    </div>
                    {a.audio_path
                      ? <audio controls src={fileUrl(projectId, a.audio_path)} style={{ width: '100%', height: 36 }} />
                      : <div className="muted" style={{ fontSize: 12 }}>{isGenerating ? '生成中…' : '（无音频文件）'}</div>}
                    <span className="muted">{a.category}</span>
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      <Button size="sm" variant="flat" onPress={() => setDetailAsset(a)}>详情</Button>
                      {!isGenerating && <Button size="sm" variant="flat" onPress={() => openEdit(a)}>编辑</Button>}
                      {st === 'failed' && <Button size="sm" variant="flat" color="warning" isDisabled={running} onPress={() => retryGenerate(a)}>重新生成</Button>}
                      {st === 'done' && a.audio_path && <Button size="sm" color="primary" isDisabled={running} onPress={() => openApply(a.id)}>应用到</Button>}
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
          {!assets.length && <p className="muted">暂无背景音乐，点「生成背景音乐」添加。</p>}
        </CardBody>
      </Card>

      {/* 生成 / 编辑背景音乐弹窗 */}
      <Modal isOpen={genOpen} backdrop="blur" onClose={() => setGenOpen(false)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">{genAssetId ? '编辑背景音乐' : '生成背景音乐'}</h2></ModalHeader>
              <ModalBody>
                <div className="flex flex-col gap-3">
                  <Input label="名称（可空）" placeholder="留空自动命名" value={genForm.name} onChange={(e) => setGenForm({ ...genForm, name: e.target.value })} />
                  <Textarea label="音乐描述 caption（必填）" placeholder="如：轻柔舒缓的钢琴纯音乐，适合夜晚治愈氛围" minRows={3} value={genForm.caption} onChange={(e) => setGenForm({ ...genForm, caption: e.target.value })} />
                  <Textarea label="歌词 lyrics（可空，纯音乐留空）" placeholder="可留空" minRows={3} value={genForm.lyrics} onChange={(e) => setGenForm({ ...genForm, lyrics: e.target.value })} />
                  <Input label="最大时长 max_duration（秒，可空走默认）" type="number" min="1" value={genForm.max_duration} onChange={(e) => setGenForm({ ...genForm, max_duration: e.target.value })} placeholder="留空按项目总时长" />
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setGenOpen(false)}>取消</Button>
                <Button size="sm" color="primary" isDisabled={busy} onPress={generateMusic}>{genAssetId ? '保存并重新生成' : '生成'}</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* 详情弹窗 */}
      <Modal isOpen={!!detailAsset} backdrop="blur" onClose={() => setDetailAsset(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">背景音乐详情</h2></ModalHeader>
              <ModalBody>
                <div className="flex flex-col gap-3">
                  <div><b>名称：</b>{detailAsset && detailAsset.name}</div>
                  <div><b>状态：</b>{detailAsset ? (STATUS_LABEL[detailAsset.status] || detailAsset.status) : ''}</div>
                  <div><b>音乐描述 caption：</b><div className="logbox" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{detailAsset && (detailAsset.prompt || '（无）')}</div></div>
                  <div><b>歌词 lyrics：</b><div className="logbox" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{detailAsset && (detailAsset.lyrics || '（无）')}</div></div>
                  <div><b>最大时长：</b>{detailAsset && detailAsset.max_duration ? detailAsset.max_duration + ' 秒' : '（默认，按项目总时长）'}</div>
                  {detailAsset && detailAsset.audio_path && (
                    <audio controls src={fileUrl(projectId, detailAsset.audio_path)} style={{ width: '100%', marginTop: 4 }} />
                  )}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setDetailAsset(null)}>关闭</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* 应用背景音乐到多个章节弹窗 */}
      <Modal isOpen={!!applyTarget} backdrop="blur" onClose={() => setApplyTarget(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">应用到章节</h2></ModalHeader>
              <ModalBody>
                <p className="muted">选择要应用该背景音乐的章节（仅已全部生成完成的章节可选）：</p>
                {doneChapters.length ? (
                  <div className="flex flex-col gap-2">
                    {doneChapters.map((c) => (
                      <Checkbox key={c.title} size="sm" isSelected={applySelection.includes(c.title)} onValueChange={() => toggleChapter(c.title)}>
                        {c.title}
                      </Checkbox>
                    ))}
                  </div>
                ) : (
                  <p className="muted">暂无已生成完成的章节。</p>
                )}
              </ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setApplyTarget(null)}>取消</Button>
                <Button size="sm" color="success" isDisabled={!applySelection.length || busy} onPress={applyMusic}>应用（{applySelection.length}）</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <LoadingOverlay show={!!busy} text={busy} />
    </div>
  );
}
