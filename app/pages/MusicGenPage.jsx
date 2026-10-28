'use client';
import { useState } from 'react';
import { Button, Input, Textarea, Card, CardBody, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useAutoProject, useAssets, useJobs, AssetGrid } from './simpleStudio';

export default function MusicGenPage() {
  const toast = useToast();
  const currentId = useAutoProject('music', '音乐生成');
  const { assets, reload } = useAssets(currentId, 'music');
  const { jobs, reloadJobs } = useJobs(currentId);
  const [caption, setCaption] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    if (!caption.trim()) { toast.error('请输入音乐描述 caption'); return; }
    setBusy(true);
    try {
      await api.post('/api/projects/' + currentId + '/music', {
        caption: caption.trim(),
        lyrics: lyrics,
        max_duration: duration === '' ? undefined : duration,
      });
      toast.success('已提交音乐生成任务');
      setCaption(''); setLyrics(''); setDuration('');
      reload(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  // 重试：音乐资产自身已存着 caption/lyrics/max_duration，直接复用同一个资产重新生成
  async function retry(a) {
    if (!currentId) throw new Error('项目初始化中，请稍候重试');
    await api.post('/api/projects/' + currentId + '/music', { asset_id: a.id });
    toast.success('已重新提交音乐生成任务');
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">音乐生成</h2>
          <Textarea size="sm" placeholder="音乐描述（风格/情绪/编曲/乐器）" value={caption} onChange={(e) => setCaption(e.target.value)} />
          <Textarea size="sm" placeholder="歌词（可选）" value={lyrics} onChange={(e) => setLyrics(e.target.value)} />
          <Input size="sm" type="number" min="1" placeholder="时长（秒，可选）" value={duration} onChange={(e) => setDuration(e.target.value)} className="w-40" />
          <div>
            <Button color="primary" isDisabled={busy || !currentId} onPress={generate}>{busy ? '提交中…' : '生成'}</Button>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="gap-2">
          <h2 className="text-lg font-semibold m-0">生成结果</h2>
          {busy && <div className="row items-center gap-2"><Spinner size="sm" /><span className="muted">生成中…</span></div>}
          <AssetGrid projectId={currentId} assets={assets} kind="audio" jobs={jobs} onRetry={retry} onChanged={() => { reload(); reloadJobs(); }} />
        </CardBody>
      </Card>
    </div>
  );
}
