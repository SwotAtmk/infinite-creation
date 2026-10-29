import { useState } from 'react';
import { Music4, Sparkles } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button, Field, Input, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { useToast } from '../components/toast.jsx';

export default function MusicGenPage() {
  const toast = useToast();
  const projectId = useAutoProject('music', '音乐生成');
  const { assets, reload } = useAssets(projectId, 'music');
  const { jobs, reloadJobs } = useJobs(projectId);
  const [caption, setCaption] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (!caption.trim()) {
      toast.error('请填写音乐描述 caption');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/projects/' + projectId + '/music', {
        caption: caption.trim(),
        lyrics,
        max_duration: duration === '' ? undefined : duration,
      });
      toast.success('已提交音乐生成任务');
      setCaption('');
      setLyrics('');
      setDuration('');
      reload();
      reloadJobs();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(asset) {
    await api.post('/api/projects/' + projectId + '/music', { asset_id: asset.id });
    toast.success('已重新提交音乐生成任务');
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Music"
        title="音乐生成"
        description="描述风格、情绪与乐器，可填歌词；结果自动归档到「作品集」的音乐生成分类下。"
      />

      <section className="panel flex flex-col gap-4 p-4">
        <Field label="音乐描述" required hint="例如：轻柔舒缓的钢琴纯音乐，适合夜晚治愈氛围。">
          <Textarea rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="风格 / 情绪 / 编曲 / 乐器" />
        </Field>
        <Field label="歌词（可选）" hint="纯音乐请留空。">
          <Textarea rows={3} value={lyrics} onChange={(e) => setLyrics(e.target.value)} placeholder="可留空" />
        </Field>
        <Field label="时长（秒，可选）" className="max-w-[220px]">
          <Input type="number" min="1" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="留空自动" />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={generate}>
            <Sparkles size={14} />
            生成音乐
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
          kind="audio"
          jobs={jobs}
          onRetry={retry}
          onChanged={() => {
            reload();
            reloadJobs();
          }}
          icon={Music4}
          emptyDescription="填写音乐描述后点击生成，生成的音频会出现在这里。"
        />
      </section>
    </div>
  );
}
