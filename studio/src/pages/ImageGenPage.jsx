import { useState } from 'react';
import { Image as ImageIcon, Sparkles } from 'lucide-react';
import { api, uploadBinary } from '../lib/api.js';
import { Button, Field, Segmented, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { FileDrop } from '../components/media.jsx';
import { FilePill, MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { useToast } from '../components/toast.jsx';

export default function ImageGenPage() {
  const toast = useToast();
  const projectId = useAutoProject('image', '图片生成');
  const { assets, reload } = useAssets(projectId, 'other');
  const { jobs, reloadJobs } = useJobs(projectId);
  const [mode, setMode] = useState('t2i');
  const [prompt, setPrompt] = useState('');
  const [refFile, setRefFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (!prompt.trim()) {
      toast.error('请输入图片提示词');
      return;
    }
    if (mode === 'i2i' && !refFile) {
      toast.error('图生图需要上传参考图');
      return;
    }
    setBusy(true);
    try {
      const asset = await api.post('/api/projects/' + projectId + '/assets', {
        category: 'other',
        name: '图片-' + Date.now().toString(36),
      });
      if (mode === 'i2i') {
        await uploadBinary('/api/projects/' + projectId + '/assets/' + asset.id + '/upload', refFile, refFile.type || 'application/octet-stream');
      }
      await api.post('/api/projects/' + projectId + '/assets/' + asset.id + '/generate', { mode, prompt: prompt.trim() });
      toast.success('已提交图片生成任务');
      setPrompt('');
      setRefFile(null);
      reload();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(asset) {
    const p = asset.params || {};
    await api.post('/api/projects/' + projectId + '/assets/' + asset.id + '/generate', {
      mode: p.mode === 'i2i' ? 'i2i' : 't2i',
      prompt: p.prompt || asset.prompt || '',
    });
    toast.success('已重新提交图片生成任务');
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Image"
        title="图片生成"
        description="文生图或图生图，结果自动归档到「作品集」的图片生成分类下。"
      />

      <section className="panel flex flex-col gap-4 p-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 't2i', label: '文生图' },
            { value: 'i2i', label: '图生图' },
          ]}
        />

        {mode === 'i2i' ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-full max-w-[280px]">
              <FileDrop
                compact
                accept="image/*"
                title={refFile ? '更换参考图' : '选择参考图'}
                hint={refFile ? '已选择 1 张图片' : 'PNG / JPG'}
                onFiles={(files) => setRefFile(files[0] || null)}
              />
            </div>
            {refFile ? <FilePill onRemove={() => setRefFile(null)}>{refFile.name}</FilePill> : null}
          </div>
        ) : null}

        <Field label="提示词" required hint="描述画面主体、风格、构图与光线，越具体越可控。">
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：黄昏的海边小镇，暖色调，电影感构图，细腻光影" />
        </Field>

        <div className="flex justify-end">
          <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={generate}>
            <Sparkles size={14} />
            生成图片
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="toolbar">
          <h2 className="m-0 text-[13px] font-semibold text-[var(--fg-2)]">生成结果</h2>
          <span className="text-[11px] text-[var(--fg-4)]">{assets.length} 个</span>
        </div>
        <MediaGrid
          projectId={projectId}
          assets={assets}
          kind="image"
          jobs={jobs}
          onRetry={retry}
          onChanged={() => {
            reload();
            reloadJobs();
          }}
          icon={ImageIcon}
          emptyDescription="输入提示词后点击生成，结果会自动出现在这里。"
        />
      </section>
    </div>
  );
}
