import { useRef, useState } from 'react';
import { Mic2, Sparkles, Upload, UserRound } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { Button, Field, Input, Select, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { FilePill, MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { Modal } from '../components/overlays.jsx';
import { fileUrl } from '../lib/format.js';
import { VIDEO_RATIO_ITEMS, VIDEO_RESOLUTION_ITEMS } from '../lib/shared.js';
import { useToast } from '../components/toast.jsx';

export default function DigitalHumanPage() {
  const toast = useToast();
  const projectId = useAutoProject('digital_human', '数字人');
  const { assets, reload } = useAssets(projectId, 'video');
  const { jobs, reloadJobs } = useJobs(projectId);

  const [avatar, setAvatar] = useState(null);
  const [refVoice, setRefVoice] = useState(null);
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState('5');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [busy, setBusy] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [voiceList, setVoiceList] = useState([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  const avatarRef = useRef(null);
  const refVoiceRef = useRef(null);

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
      else setRefVoice(item);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function openPicker() {
    setPickerOpen(true);
    setLoadingVoices(true);
    try {
      const list = await api.get('/api/voice-assets');
      setVoiceList(Array.isArray(list) ? list : []);
    } catch (e) {
      toast.error(e.message);
      setVoiceList([]);
    } finally {
      setLoadingVoices(false);
    }
  }

  function pickVoice(item) {
    setRefVoice({ path: item.ref_path, project_id: item.project_id, name: item.name });
    setPickerOpen(false);
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
    if (!refVoice) {
      toast.error('请上传或选择参考音色');
      return;
    }
    if (!text.trim()) {
      toast.error('请输入说话内容');
      return;
    }
    if (!prompt.trim()) {
      toast.error('请输入提示词');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/projects/' + projectId + '/digital-human', {
        text: text.trim(),
        prompt: prompt.trim(),
        seconds: Number(seconds) || 5,
        resolution: res,
        aspect_ratio: ratio,
        avatar: avatar.path,
        ref_audio: refVoice.path,
        ref_audio_project_id: refVoice.project_id || '',
      });
      toast.success('已提交数字人生成任务');
      setText('');
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
    await api.post('/api/projects/' + projectId + '/digital-human', {
      asset_id: asset.id,
      text: p.text || '',
      prompt: p.prompt || asset.prompt || '',
      seconds: p.seconds,
      resolution: p.resolution,
      aspect_ratio: p.aspect_ratio,
      avatar: p.avatar || '',
      ref_audio: p.ref_audio || '',
      ref_audio_project_id: p.ref_audio_project_id || '',
    });
    toast.success('已重新提交数字人生成任务');
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Digital human"
        title="数字人"
        description="上传人物头像与参考音色，填写说话内容，系统先生成语音再驱动数字人口型；结果归档到数字人分类。"
      />

      <section className="panel flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1 rounded-xl border border-[color-mix(in_srgb,var(--info)_26%,transparent)] bg-[color-mix(in_srgb,var(--info)_9%,transparent)] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--fg-2)]">
          <span>本地运行需先下载补充 ComfyUI 模型（Qwen3-TTS 音色克隆相关权重）。</span>
          <span className="break-all">
            下载地址：
            <a
              href="https://pan.quark.cn/s/0a46c36599b4?pwd=x5yC"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent)] underline decoration-[color-mix(in_srgb,var(--accent)_40%,transparent)] underline-offset-2"
            >
              https://pan.quark.cn/s/0a46c36599b4?pwd=x5yC
            </a>
            （提取码：x5yC）
          </span>
        </div>
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
              <Upload size={13} /> 上传角色图片
            </Button>
            <Button variant="secondary" size="sm" onClick={() => refVoiceRef.current?.click()}>
              <Upload size={13} /> 上传参考音色
            </Button>
            <Button variant="secondary" size="sm" onClick={openPicker}>
              <Mic2 size={13} /> 选择已有音色
            </Button>
            <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPick(e, 'avatar')} />
            <input ref={refVoiceRef} type="file" accept="audio/*" className="hidden" onChange={(e) => onPick(e, 'refVoice')} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {avatar ? <FilePill onRemove={() => setAvatar(null)}>头像：{avatar.name}</FilePill> : null}
            {refVoice ? <FilePill onRemove={() => setRefVoice(null)}>参考音色：{refVoice.name}</FilePill> : null}
          </div>
        </div>

        <Field label="说话内容" required hint="将被克隆音色朗读、用于驱动数字人口型的台词。">
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="输入数字人要说的内容" />
        </Field>

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
          emptyDescription="上传角色图片、参考音色并填写说话内容后点击生成，数字人视频会出现在这里。"
        />
      </section>

      <Modal
        open={pickerOpen}
        onOpenChange={(o) => !o && setPickerOpen(false)}
        title="选择已有音色"
        description="从音色设计 / 音色克隆的生成结果中选择一个作为参考音色。"
        size="lg"
        footer={
          <Button variant="secondary" size="md" onClick={() => setPickerOpen(false)}>
            取消
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {loadingVoices ? (
            <p className="m-0 text-[12px] text-[var(--fg-3)]">加载中…</p>
          ) : voiceList.length ? (
            <div className="grid max-h-[380px] grid-cols-1 gap-2 overflow-y-auto pr-1">
              {voiceList.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-white/[0.02] p-2.5"
                >
                  <audio src={fileUrl(v.project_id, v.ref_path)} controls preload="metadata" className="h-8 w-full min-w-0 flex-1" />
                  <div className="flex w-[200px] shrink-0 flex-col overflow-hidden">
                    <span className="truncate text-[12px] text-[var(--fg)]">{v.name}</span>
                    <span className="truncate text-[11px] text-[var(--fg-4)]">{v.project_name}</span>
                  </div>
                  <Button variant="secondary" size="xs" onClick={() => pickVoice(v)}>
                    选择
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-[var(--fg-3)]">暂无可用音色，请先在「音色设计」或「音色克隆」中生成，或直接上传参考音色。</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
