import { useState } from 'react';
import { Mic2, Sparkles } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button, Field, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { useToast } from '../components/toast.jsx';

export default function VoiceDesignPage() {
  const toast = useToast();
  const projectId = useAutoProject('tts', '音色设计');
  const { assets, reload } = useAssets(projectId, 'voice');
  const { jobs, reloadJobs } = useJobs(projectId);
  const [text, setText] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (!text.trim()) {
      toast.error('请输入朗读文案');
      return;
    }
    setBusy(true);
    try {
      const asset = await api.post('/api/projects/' + projectId + '/assets', {
        category: 'voice',
        name: '音色-' + Date.now().toString(36),
      });
      await api.post('/api/projects/' + projectId + '/assets/' + asset.id + '/design-voice', {
        text: text.trim(),
        voice_description: desc,
      });
      toast.success('已提交音色设计任务');
      setText('');
      setDesc('');
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
    await api.post('/api/projects/' + projectId + '/assets/' + asset.id + '/design-voice', {
      text: p.text || '',
      voice_description: p.voice_description || '',
    });
    toast.success('已重新提交音色设计任务');
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Voice"
        title="音色设计"
        description="用一段朗读文案生成音色样本，可附加性别、年龄、声线等描述。"
      />

      <section className="panel flex flex-col gap-4 p-4">
        <Field label="朗读文案" required hint="文案会作为音色样本的朗读内容。">
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="输入用于生成音色样本的朗读文案" />
        </Field>
        <Field label="音色描述（可选）">
          <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="例如：青年女性，温柔清亮，语速偏慢" />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={generate}>
            <Sparkles size={14} />
            生成音色
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
          icon={Mic2}
          emptyDescription="填写朗读文案后点击生成，音色样本会出现在这里。"
        />
      </section>
    </div>
  );
}
