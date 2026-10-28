'use client';
import { useState, useRef } from 'react';
import { Button, Textarea, Card, CardBody, Radio, RadioGroup, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useAutoProject, useAssets, useJobs, AssetGrid } from './simpleStudio';

export default function ImageGenPage() {
  const toast = useToast();
  const currentId = useAutoProject('image', '图片生成');
  const { assets, reload } = useAssets(currentId, 'other');
  const { jobs, reloadJobs } = useJobs(currentId);
  const [mode, setMode] = useState('t2i');
  const [prompt, setPrompt] = useState('');
  const [refFile, setRefFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function uploadAsset(projectId, assetId, file) {
    const res = await fetch('/api/projects/' + projectId + '/assets/' + assetId + '/upload', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('上传失败 HTTP ' + res.status));
    return j;
  }

  async function generate() {
    if (!currentId) { toast.error('项目初始化中，请稍候重试'); return; }
    if (!prompt.trim()) { toast.error('请输入提示词'); return; }
    if (mode === 'i2i' && !refFile) { toast.error('图生图需要上传参考图'); return; }
    setBusy(true);
    try {
      const asset = await api.post('/api/projects/' + currentId + '/assets', { category: 'other', name: '图片-' + Date.now().toString(36) });
      if (mode === 'i2i') await uploadAsset(currentId, asset.id, refFile);
      await api.post('/api/projects/' + currentId + '/assets/' + asset.id + '/generate', { mode, prompt: prompt.trim() });
      toast.success('已提交图片生成任务');
      setPrompt(''); setRefFile(null);
      reload(); reloadJobs();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  // 重试：按上次保存的 params 重新提交（图生图沿用资产自身已有的参考图）
  async function retry(a) {
    if (!currentId) throw new Error('项目初始化中，请稍候重试');
    const p = a.params || {};
    await api.post('/api/projects/' + currentId + '/assets/' + a.id + '/generate', {
      mode: p.mode === 'i2i' ? 'i2i' : 't2i',
      prompt: p.prompt || a.prompt || '',
    });
    toast.success('已重新提交图片生成任务');
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">图片生成</h2>
          <RadioGroup label="模式" orientation="horizontal" value={mode} onValueChange={setMode}>
            <Radio value="t2i">文生图</Radio>
            <Radio value="i2i">图生图</Radio>
          </RadioGroup>
          {mode === 'i2i' && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <Button size="sm" variant="flat" onPress={() => fileRef.current && fileRef.current.click()}>选择参考图</Button>
              <span className="muted">{refFile ? refFile.name : '未选择'}</span>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { setRefFile(e.target.files && e.target.files[0] || null); e.target.value = ''; }} />
            </div>
          )}
          <Textarea size="sm" placeholder="输入图片提示词" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div>
            <Button color="primary" isDisabled={busy || !currentId} onPress={generate}>{busy ? '提交中…' : '生成'}</Button>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="gap-2">
          <h2 className="text-lg font-semibold m-0">生成结果</h2>
          {busy && <div className="row items-center gap-2"><Spinner size="sm" /><span className="muted">生成中…</span></div>}
          <AssetGrid projectId={currentId} assets={assets} kind="image" jobs={jobs} onRetry={retry} onChanged={() => { reload(); reloadJobs(); }} />
        </CardBody>
      </Card>
    </div>
  );
}
