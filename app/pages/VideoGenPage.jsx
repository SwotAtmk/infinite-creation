'use client';
import { useState, useRef } from 'react';
import { Button, Input, Textarea, Select, SelectItem, Card, CardBody, Spinner, Chip } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useAutoProject, useAssets, useJobs, AssetGrid } from './simpleStudio';
import { selectKeys, pickKey, VIDEO_RESOLUTIONS, VIDEO_RATIOS } from './shared';

const MODES = [
  ['reference', '参考生视频（图/音频/视频）'],
  ['image', '图生视频（需 1 张图）'],
  ['first_last', '首尾帧（需首帧+尾帧 2 张图）'],
];

export default function VideoGenPage() {
  const toast = useToast();
  const currentId = useAutoProject('video', '视频生成');
  const { assets, reload } = useAssets(currentId, 'video');
  const { jobs, reloadJobs } = useJobs(currentId);
  const [mode, setMode] = useState('reference');
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState('5');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [images, setImages] = useState([]);
  const [audios, setAudios] = useState([]);
  const [videos, setVideos] = useState([]);
  // 首尾帧模式两个固定槽位（顺序决定「首帧→尾帧」，不能靠数组下标猜）
  const [firstFrame, setFirstFrame] = useState(null);
  const [lastFrame, setLastFrame] = useState(null);
  const [busy, setBusy] = useState(false);

  const imgRef = useRef(null); const audRef = useRef(null); const vidRef = useRef(null);
  const firstRef = useRef(null); const lastRef = useRef(null);

  async function uploadOne(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/projects/' + currentId + '/media', { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('上传失败 HTTP ' + res.status));
    return j; // { path, kind }
  }

  async function onFiles(e, kind) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    try {
      const added = [];
      for (const f of files) added.push({ path: (await uploadOne(f)).path, name: f.name });
      if (kind === 'image') {
        // 图生视频只认 1 张图：再次选择就是替换，不累积
        setImages(mode === 'image' ? added.slice(0, 1) : (p) => [...p, ...added]);
      }
      else if (kind === 'audio') setAudios((p) => [...p, ...added]);
      else setVideos((p) => [...p, ...added]);
    } catch (err) { toast.error(err.message); }
  }

  // 首尾帧槽位：单张，重复选择即替换
  async function onFrame(e, which) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    try {
      const item = { path: (await uploadOne(files[0])).path, name: files[0].name };
      if (which === 'first') setFirstFrame(item); else setLastFrame(item);
    } catch (err) { toast.error(err.message); }
  }

  // 切模式时清空上一模式上传的物料，避免残留素材数量与新模式的约束冲突
  function changeMode(k) {
    setMode(k);
    setImages([]); setAudios([]); setVideos([]);
    setFirstFrame(null); setLastFrame(null);
  }

  function removeItem(kind, i) {
    if (kind === 'image') setImages((p) => p.filter((_, idx) => idx !== i));
    else if (kind === 'audio') setAudios((p) => p.filter((_, idx) => idx !== i));
    else setVideos((p) => p.filter((_, idx) => idx !== i));
  }

  function buildReferences() {
    // 首尾帧固定「首帧 → 尾帧」顺序；图生视频只取那 1 张
    if (mode === 'first_last') return [firstFrame, lastFrame].filter(Boolean).map((m) => ({ type: 'image', filename: m.path }));
    if (mode === 'image') return images.slice(0, 1).map((m) => ({ type: 'image', filename: m.path }));
    return [
      ...images.map((m) => ({ type: 'image', filename: m.path })),
      ...audios.map((m) => ({ type: 'audio', filename: m.path })),
      ...videos.map((m) => ({ type: 'video', filename: m.path })),
    ];
  }

  async function generate() {
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    if (!prompt.trim()) { toast.error('请输入视频提示词'); return; }
    if (mode === 'image' && images.length !== 1) { toast.error('图生视频必须上传 1 张图片'); return; }
    if (mode === 'first_last' && (!firstFrame || !lastFrame)) { toast.error('首尾帧必须上传首帧和尾帧两张图片'); return; }
    if (mode === 'reference' && !images.length && !videos.length) { toast.error('参考生视频至少需要 1 张图或 1 段视频'); return; }
    if (mode === 'reference' && (images.length > 9 || audios.length + videos.length > 3)) { toast.error('参考生视频最多 9 张图、3 段音视频'); return; }
    setBusy(true);
    try {
      await api.post('/api/projects/' + currentId + '/video', {
        mode: mode === 'first_last' ? 'image' : mode,
        prompt: prompt.trim(),
        seconds: Number(seconds) || 5,
        resolution: res,
        aspect_ratio: ratio,
        references: buildReferences(),
      });
      toast.success('已提交视频生成任务');
      setPrompt('');
      reload(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  // 重试：按上次保存的 params 复用同一个视频资产重新生成
  async function retry(a) {
    if (!currentId) throw new Error('项目初始化中，请稍候重试');
    const p = a.params || {};
    await api.post('/api/projects/' + currentId + '/video', {
      asset_id: a.id,
      mode: p.mode || 'reference',
      prompt: p.prompt || a.prompt || '',
      seconds: p.seconds,
      resolution: p.resolution,
      aspect_ratio: p.aspect_ratio,
      references: Array.isArray(p.references) ? p.references : [],
    });
    toast.success('已重新提交视频生成任务');
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">视频生成</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted">模式</span>
            <Select size="sm" className="w-64" aria-label="模式" selectedKeys={selectKeys(mode)} onSelectionChange={(k) => changeMode(pickKey(k))}>
              {MODES.map(([v, l]) => <SelectItem key={v}>{l}</SelectItem>)}
            </Select>
            <span className="muted">分辨率</span>
            <Select size="sm" className="w-32" aria-label="分辨率" selectedKeys={selectKeys(res)} onSelectionChange={(k) => setRes(pickKey(k))}>
              {VIDEO_RESOLUTIONS.map(([v, l]) => <SelectItem key={v}>{l}</SelectItem>)}
            </Select>
            <span className="muted">比例</span>
            <Select size="sm" className="w-28" aria-label="比例" selectedKeys={selectKeys(ratio)} onSelectionChange={(k) => setRatio(pickKey(k))}>
              {VIDEO_RATIOS.map((r) => <SelectItem key={r}>{r}</SelectItem>)}
            </Select>
            <span className="muted">时长</span>
            <Input size="sm" type="number" min="1" max="15" value={seconds} onChange={(e) => setSeconds(e.target.value)} className="w-20" />
          </div>

          <div className="flex flex-col gap-2">
            {mode === 'first_last' ? (
              <>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button size="sm" variant={firstFrame ? 'flat' : 'solid'} color={firstFrame ? 'default' : 'primary'}
                    onPress={() => firstRef.current && firstRef.current.click()}>
                    {firstFrame ? '更换首帧图' : '＋ 上传首帧图（必填）'}
                  </Button>
                  <Button size="sm" variant={lastFrame ? 'flat' : 'solid'} color={lastFrame ? 'default' : 'primary'}
                    onPress={() => lastRef.current && lastRef.current.click()}>
                    {lastFrame ? '更换尾帧图' : '＋ 上传尾帧图（必填）'}
                  </Button>
                  <span className="muted" style={{ fontSize: 12 }}>首尾帧模式：必须各上传 1 张，顺序固定为「首帧 → 尾帧」</span>
                </div>
                <input ref={firstRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFrame(e, 'first')} />
                <input ref={lastRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFrame(e, 'last')} />
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {firstFrame && <Chip size="sm" variant="flat" color="primary" onClose={() => setFirstFrame(null)}>首帧：{firstFrame.name}</Chip>}
                  {lastFrame && <Chip size="sm" variant="flat" color="primary" onClose={() => setLastFrame(null)}>尾帧：{lastFrame.name}</Chip>}
                </div>
              </>
            ) : (
              <>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button size="sm" variant={mode === 'image' && !images.length ? 'solid' : 'flat'} color={mode === 'image' && !images.length ? 'primary' : 'default'}
                    onPress={() => imgRef.current && imgRef.current.click()}>
                    {mode === 'image' ? (images.length ? '更换图片（1 张）' : '＋ 上传图片（必填，1 张）') : ('＋ 参考图（' + images.length + '）')}
                  </Button>
                  {mode === 'reference' && <Button size="sm" variant="flat" onPress={() => audRef.current && audRef.current.click()}>＋ 参考音频（{audios.length}）</Button>}
                  {mode === 'reference' && <Button size="sm" variant="flat" onPress={() => vidRef.current && vidRef.current.click()}>＋ 参考视频（{videos.length}）</Button>}
                  {mode === 'image' && <span className="muted" style={{ fontSize: 12 }}>图生视频：必须上传且仅上传 1 张图片</span>}
                  <input ref={imgRef} type="file" accept="image/*" multiple={mode === 'reference'} style={{ display: 'none' }} onChange={(e) => onFiles(e, 'image')} />
                  <input ref={audRef} type="file" accept="audio/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e, 'audio')} />
                  <input ref={vidRef} type="file" accept="video/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e, 'video')} />
                </div>
                {[[images, 'image'], [audios, 'audio'], [videos, 'video']].map(([list, kind]) => list.length > 0 && (
                  <div key={kind} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {list.map((m, i) => (
                      <Chip key={i} size="sm" variant="flat" onClose={() => removeItem(kind, i)}>{m.name}</Chip>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>

          <Textarea size="sm" placeholder="输入视频提示词" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div>
            <Button color="primary" isDisabled={busy || !currentId} onPress={generate}>{busy ? '提交中…' : '生成'}</Button>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="gap-2">
          <h2 className="text-lg font-semibold m-0">生成结果</h2>
          {busy && <div className="row items-center gap-2"><Spinner size="sm" /><span className="muted">生成中…</span></div>}
          <AssetGrid projectId={currentId} assets={assets} kind="video" jobs={jobs} onRetry={retry} onChanged={() => { reload(); reloadJobs(); }} />
        </CardBody>
      </Card>
    </div>
  );
}
