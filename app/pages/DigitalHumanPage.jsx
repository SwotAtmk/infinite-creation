'use client';
import { useState, useRef } from 'react';
import { Button, Input, Textarea, Select, SelectItem, Card, CardBody, Spinner, Chip } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useAutoProject, useAssets, useJobs, AssetGrid } from './simpleStudio';
import { selectKeys, pickKey, VIDEO_RESOLUTIONS, VIDEO_RATIOS } from './shared';

export default function DigitalHumanPage() {
  const toast = useToast();
  const currentId = useAutoProject('digital_human', '数字人');
  const { assets, reload } = useAssets(currentId, 'video');
  const { jobs, reloadJobs } = useJobs(currentId);
  const [avatar, setAvatar] = useState(null); // { path, name }
  const [audio, setAudio] = useState(null); // { path, name }
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState('5');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [busy, setBusy] = useState(false);
  const avatarRef = useRef(null); const audioRef = useRef(null);

  async function uploadOne(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/projects/' + currentId + '/media', { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('上传失败 HTTP ' + res.status));
    return { path: j.path, name: file.name, kind: j.kind };
  }

  async function onAvatar(e) {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    try { setAvatar(await uploadOne(f)); } catch (err) { toast.error(err.message); }
  }
  async function onAudio(e) {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    try { setAudio(await uploadOne(f)); } catch (err) { toast.error(err.message); }
  }

  async function generate() {
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    if (!avatar) { toast.error('请上传人物头像（视觉参考）'); return; }
    if (!audio) { toast.error('请上传驱动音频'); return; }
    if (!prompt.trim()) { toast.error('请输入提示词'); return; }
    setBusy(true);
    try {
      await api.post('/api/projects/' + currentId + '/video', {
        mode: 'digital_human',
        prompt: prompt.trim(),
        seconds: Number(seconds) || 5,
        resolution: res,
        aspect_ratio: ratio,
        references: [
          { type: 'image', filename: avatar.path },
          { type: 'audio', filename: audio.path },
        ],
      });
      toast.success('已提交数字人生成任务');
      setPrompt('');
      reload(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  // 重试：数字人沿用上次保存的头像 + 驱动音频 + 提示词，复用同一个视频资产重新生成
  async function retry(a) {
    if (!currentId) throw new Error('项目初始化中，请稍候重试');
    const p = a.params || {};
    await api.post('/api/projects/' + currentId + '/video', {
      asset_id: a.id,
      mode: p.mode || 'digital_human',
      prompt: p.prompt || a.prompt || '',
      seconds: p.seconds,
      resolution: p.resolution,
      aspect_ratio: p.aspect_ratio,
      references: Array.isArray(p.references) ? p.references : [],
    });
    toast.success('已重新提交数字人生成任务');
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">数字人</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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

          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="sm" variant="flat" onPress={() => avatarRef.current && avatarRef.current.click()}>上传头像（视觉参考）</Button>
            <Button size="sm" variant="flat" onPress={() => audioRef.current && audioRef.current.click()}>上传驱动音频</Button>
            <input ref={avatarRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onAvatar} />
            <input ref={audioRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={onAudio} />
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {avatar && <Chip size="sm" variant="flat" color="primary" onClose={() => setAvatar(null)}>头像：{avatar.name}</Chip>}
            {audio && <Chip size="sm" variant="flat" color="primary" onClose={() => setAudio(null)}>音频：{audio.name}</Chip>}
          </div>

          <Textarea size="sm" placeholder="输入提示词（人物/背景/口型风格描述）" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div>
            <Button color="primary" isDisabled={busy || !currentId} onPress={generate}>{busy ? '提交中…' : '生成'}</Button>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>预留接口：TTS 语音克隆（参考音频 + 口播文案 → 驱动音频），暂未接入。</div>
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
