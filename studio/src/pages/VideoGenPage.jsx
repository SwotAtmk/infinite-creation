import { useRef, useState } from 'react';
import { Film, Plus, Sparkles } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { Button, Field, Input, Segmented, Select, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { FilePill, MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { VIDEO_RATIO_ITEMS, VIDEO_RESOLUTION_ITEMS } from '../lib/shared.js';
import { useToast } from '../components/toast.jsx';

const MODES = [
  { value: 'reference', label: '参考生视频' },
  { value: 'image', label: '图生视频' },
  { value: 'first_last', label: '首尾帧' },
];

export default function VideoGenPage() {
  const toast = useToast();
  const projectId = useAutoProject('video', '视频生成');
  const { assets, reload } = useAssets(projectId, 'video');
  const { jobs, reloadJobs } = useJobs(projectId);

  const [mode, setMode] = useState('reference');
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState('5');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [images, setImages] = useState([]);
  const [audios, setAudios] = useState([]);
  const [videos, setVideos] = useState([]);
  const [firstFrame, setFirstFrame] = useState(null);
  const [lastFrame, setLastFrame] = useState(null);
  const [busy, setBusy] = useState(false);

  const imgRef = useRef(null);
  const audRef = useRef(null);
  const vidRef = useRef(null);
  const firstRef = useRef(null);
  const lastRef = useRef(null);

  async function uploadMedia(file) {
    const fd = new FormData();
    fd.append('file', file);
    const j = await uploadForm('/api/projects/' + projectId + '/media', fd);
    return { path: j.path, name: file.name };
  }

  async function onFiles(e, kind) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    try {
      const added = [];
      for (const f of files) added.push(await uploadMedia(f));
      if (kind === 'image') {
        // 图生视频只认 1 张：再次选择就是替换
        if (mode === 'image') setImages(added.slice(0, 1));
        else setImages((prev) => [...prev, ...added]);
      } else if (kind === 'audio') {
        setAudios((prev) => [...prev, ...added]);
      } else {
        setVideos((prev) => [...prev, ...added]);
      }
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function onFrame(e, which) {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    try {
      const item = await uploadMedia(file);
      if (which === 'first') setFirstFrame(item);
      else setLastFrame(item);
    } catch (err) {
      toast.error(err.message);
    }
  }

  function changeMode(next) {
    setMode(next);
    setImages([]);
    setAudios([]);
    setVideos([]);
    setFirstFrame(null);
    setLastFrame(null);
  }

  function buildReferences() {
    if (mode === 'first_last') {
      return [firstFrame, lastFrame].filter(Boolean).map((m) => ({ type: 'image', filename: m.path }));
    }
    if (mode === 'image') return images.slice(0, 1).map((m) => ({ type: 'image', filename: m.path }));
    return [
      ...images.map((m) => ({ type: 'image', filename: m.path })),
      ...audios.map((m) => ({ type: 'audio', filename: m.path })),
      ...videos.map((m) => ({ type: 'video', filename: m.path })),
    ];
  }

  async function generate() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (!prompt.trim()) {
      toast.error('请输入视频提示词');
      return;
    }
    if (mode === 'image' && images.length !== 1) {
      toast.error('图生视频必须上传 1 张图片');
      return;
    }
    if (mode === 'first_last' && (!firstFrame || !lastFrame)) {
      toast.error('首尾帧必须上传首帧和尾帧两张图片');
      return;
    }
    if (mode === 'reference' && !images.length && !videos.length) {
      toast.error('参考生视频至少需要 1 张图或 1 段视频');
      return;
    }
    if (mode === 'reference' && (images.length > 9 || audios.length + videos.length > 3)) {
      toast.error('参考生视频最多 9 张图、3 段音视频');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/projects/' + projectId + '/video', {
        mode: mode === 'first_last' ? 'image' : mode,
        prompt: prompt.trim(),
        seconds: Number(seconds) || 5,
        resolution: res,
        aspect_ratio: ratio,
        references: buildReferences(),
      });
      toast.success('已提交视频生成任务');
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
      mode: p.mode || 'reference',
      prompt: p.prompt || asset.prompt || '',
      seconds: p.seconds,
      resolution: p.resolution,
      aspect_ratio: p.aspect_ratio,
      references: Array.isArray(p.references) ? p.references : [],
    });
    toast.success('已重新提交视频生成任务');
  }

  const removeFrom = (list, setList, index) => setList(list.filter((_, i) => i !== index));

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Video"
        title="视频生成"
        description="参考生视频、图生视频与首尾帧三种模式，结果自动归档到「作品集」的视频生成分类下。"
      />

      <section className="panel flex flex-col gap-4 p-4">
        <Segmented value={mode} onChange={changeMode} options={MODES} />

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

        {mode === 'first_last' ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => firstRef.current?.click()}>
                <Plus size={13} /> {firstFrame ? '更换首帧图' : '上传首帧图'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => lastRef.current?.click()}>
                <Plus size={13} /> {lastFrame ? '更换尾帧图' : '上传尾帧图'}
              </Button>
              <input ref={firstRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFrame(e, 'first')} />
              <input ref={lastRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFrame(e, 'last')} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {firstFrame ? <FilePill onRemove={() => setFirstFrame(null)}>首帧：{firstFrame.name}</FilePill> : null}
              {lastFrame ? <FilePill onRemove={() => setLastFrame(null)}>尾帧：{lastFrame.name}</FilePill> : null}
            </div>
            <p className="m-0 text-[11px] text-[var(--fg-4)]">首尾帧模式必须各上传 1 张，顺序固定为「首帧 → 尾帧」。</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => imgRef.current?.click()}>
                <Plus size={13} /> {mode === 'image' ? (images.length ? '更换图片（1 张）' : '上传图片') : '参考图（' + images.length + '）'}
              </Button>
              {mode === 'reference' ? (
                <>
                  <Button variant="secondary" size="sm" onClick={() => audRef.current?.click()}>
                    <Plus size={13} /> 参考音频（{audios.length}）
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => vidRef.current?.click()}>
                    <Plus size={13} /> 参考视频（{videos.length}）
                  </Button>
                </>
              ) : null}
              <input ref={imgRef} type="file" accept="image/*" multiple={mode === 'reference'} className="hidden" onChange={(e) => onFiles(e, 'image')} />
              <input ref={audRef} type="file" accept="audio/*" multiple className="hidden" onChange={(e) => onFiles(e, 'audio')} />
              <input ref={vidRef} type="file" accept="video/*" multiple className="hidden" onChange={(e) => onFiles(e, 'video')} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {images.map((m, i) => (
                <FilePill key={'img-' + i} onRemove={() => removeFrom(images, setImages, i)}>{m.name}</FilePill>
              ))}
              {audios.map((m, i) => (
                <FilePill key={'aud-' + i} onRemove={() => removeFrom(audios, setAudios, i)}>{m.name}</FilePill>
              ))}
              {videos.map((m, i) => (
                <FilePill key={'vid-' + i} onRemove={() => removeFrom(videos, setVideos, i)}>{m.name}</FilePill>
              ))}
            </div>
            {mode === 'image' ? <p className="m-0 text-[11px] text-[var(--fg-4)]">图生视频必须上传且仅上传 1 张图片。</p> : null}
            {mode === 'reference' ? (
              <p className="m-0 text-[11px] text-[var(--fg-4)]">参考生视频最多 9 张图、3 段音视频，至少需要 1 张图或 1 段视频。</p>
            ) : null}
          </div>
        )}

        <Field label="提示词" required>
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述镜头运动、主体动作、场景氛围…" />
        </Field>

        <div className="flex justify-end">
          <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={generate}>
            <Sparkles size={14} />
            生成视频
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
          icon={Film}
          emptyDescription="上传参考素材并填写提示词，生成的视频会出现在这里。"
        />
      </section>
    </div>
  );
}
