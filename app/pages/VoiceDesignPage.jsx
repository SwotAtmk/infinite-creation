'use client';
import { useState } from 'react';
import { Button, Textarea, Card, CardBody, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useAutoProject, useAssets, useJobs, AssetGrid } from './simpleStudio';

export default function VoiceDesignPage() {
  const toast = useToast();
  const currentId = useAutoProject('tts', '音色设计');
  const { assets, reload } = useAssets(currentId, 'voice');
  const { jobs, reloadJobs } = useJobs(currentId);
  const [text, setText] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    if (!text.trim()) { toast.error('请输入朗读文案'); return; }
    setBusy(true);
    try {
      const asset = await api.post('/api/projects/' + currentId + '/assets', { category: 'voice', name: '音色-' + Date.now().toString(36) });
      await api.post('/api/projects/' + currentId + '/assets/' + asset.id + '/design-voice', {
        text: text.trim(),
        voice_description: desc,
      });
      toast.success('已提交音色设计任务');
      setText(''); setDesc('');
      reload(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  // 重试：按上次保存的 params（文案 + 音色描述）复用同一个音色资产重新生成
  async function retry(a) {
    if (!currentId) throw new Error('项目初始化中，请稍候重试');
    const p = a.params || {};
    await api.post('/api/projects/' + currentId + '/assets/' + a.id + '/design-voice', {
      text: p.text || '',
      voice_description: p.voice_description || '',
    });
    toast.success('已重新提交音色设计任务');
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">音色设计</h2>
          <Textarea size="sm" placeholder="朗读文案（用于生成音色样本）" value={text} onChange={(e) => setText(e.target.value)} />
          <Textarea size="sm" placeholder="音色描述（性别/年龄/声线，可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
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
