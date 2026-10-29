import { useRef, useState } from 'react';
import { Sparkles, Upload, UserRound } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { Button, Field, Input, Select, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { FilePill, MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { VIDEO_RATIO_ITEMS, VIDEO_RESOLUTION_ITEMS } from '../lib/shared.js';
import { useToast } from '../components/toast.jsx';

export default function DigitalHumanPage() {
  const toast = useToast();
  const projectId = useAutoProject('digital_human', '数字人');
  const { assets, reload } = useAssets(projectId, 'video');
  const { jobs, reloadJobs } = useJobs(projectId);

  const [avatar, setAvatar] = useState(null);
  const [audio, setAudio] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState('5');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [busy, setBusy] = useState(false);

  const avatarRef = useRef(null);
  const audioRef = useRef(null);

  async function uploadMedia(file) {
    const fd = new FormData();
    fd.append('file', file);
    const j = await uploadForm('/api/projects/' + projectId + '/media', fd);
    return { path: j.path, name: file.name };
  }

  async function onPick(e, which) {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    try {
      const item = await uploadMedia(file);
      if (which === 'avatar') setAvatar(item);
      else setAudio(item);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function generate() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (!avatar) {
      toast.error('请上传人物头像（视觉参考）');
      return;
    }
    if (!audio) {
      toast.error('请上传驱动音频');
      return;
    }
    if (!prompt.trim()) {
      toast.error('请输入提示词');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/projects/' + projectId + '/video', {
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
    await api.post('/api/projects/' + projectId + '/video', {
      asset_id: asset.id,
      mode: p.mode || 'digital_human',
      prompt: p.prompt || asset.prompt || '',
      seconds: p.seconds,
      resolution: p.resolution,
      aspect_ratio: p.aspect_ratio,
      references: Array.isArray(p.references) ? p.references : [],
    });
    toast.success('已重新提交数字人生成任务');
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Digital human"
        title="数字人"
        description="上传人物头像与驱动音频，生成带口型表现的数字人视频；结果归档到数字人分类。"
      />

      <section className="panel flex flex-col gap-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="分辨率">
            <Select value={res} onChange={setRes} items={VIDEO_RESOLUTION_ITEMS} />
          </Field>
          <Field label="宽高比">
            <Select value={ratio} onChange={setRatio} items={VIDEO_RATIO_ITEMS} />
          </Field>
          <Field label="时长（秒）">
            <Input type="number" min="1" max="15" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => avatarRef.current?.click()}>
              <Upload size={13} /> 上传头像
            </Button>
            <Button variant="secondary" size="sm" onClick={() => audioRef.current?.click()}>
              <Upload size={13} /> 上传驱动音频
            </Button>
            <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPick(e, 'avatar')} />
            <input ref={audioRef} type="file" accept="audio/*" className="hidden" onChange={(e) => onPick(e, 'audio')} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {avatar ? <FilePill onRemove={() => setAvatar(null)}>头像：{avatar.name}</FilePill> : null}
            {audio ? <FilePill onRemove={() => setAudio(null)}>音频：{audio.name}</FilePill> : null}
          </div>
        </div>

        <Field label="提示词" required hint="描述人物、背景、口型与镜头风格。">
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：主播半身像，正面镜头，自然口型，简洁背景" />
        </Field>

        <div className="flex justify-end">
          <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={generate}>
            <Sparkles size={14} />
            生成数字人视频
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
          kind="video"
          jobs={jobs}
          onRetry={retry}
          onChanged={() => {
            reload();
            reloadJobs();
          }}
          icon={UserRound}
          emptyDescription="上传头像和驱动音频后点击生成，数字人视频会出现在这里。"
        />
      </section>
    </div>
  );
}
