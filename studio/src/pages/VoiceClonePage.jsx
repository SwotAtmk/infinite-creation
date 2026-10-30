import { useRef, useState } from 'react';
import { Mic2, Sparkles, Upload } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { Button, Field, Textarea } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { FilePill, MediaGrid, useAssets, useAutoProject, useJobs } from '../components/simpleStudio.jsx';
import { useToast } from '../components/toast.jsx';

export default function VoiceClonePage() {
  const toast = useToast();
  const projectId = useAutoProject('tts_clone', '音色克隆');
  const { assets, reload } = useAssets(projectId, 'voice');
  const { jobs, reloadJobs } = useJobs(projectId);
  const [text, setText] = useState('');
  const [refVoice, setRefVoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function uploadRef(file) {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const j = await uploadForm('/api/projects/' + projectId + '/media', fd);
      setRefVoice({ path: j.path, name: file.name });
    } catch (e) {
      toast.error(e.message);
    }
  }

  function onPick(e) {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (file) uploadRef(file);
  }

  async function generate() {
    if (!projectId) {
      toast.error('项目初始化中，请稍候重试');
      return;
    }
    if (!text.trim()) {
      toast.error('请输入说话内容');
      return;
    }
    if (!refVoice) {
      toast.error('请上传参考音色');
      return;
    }
    setBusy(true);
    try {
      const asset = await api.post('/api/projects/' + projectId + '/assets', {
        category: 'voice',
        name: '克隆-' + Date.now().toString(36),
      });
      await api.post('/api/projects/' + projectId + '/assets/' + asset.id + '/clone-voice', {
        text: text.trim(),
        ref_audio: refVoice.path,
      });
      toast.success('已提交音色克隆任务');
      setText('');
      setRefVoice(null);
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
    await api.post('/api/projects/' + projectId + '/assets/' + asset.id + '/clone-voice', {
      text: p.text || '',
      ref_audio: p.ref_audio || '',
      ref_audio_project_id: p.ref_audio_project_id || '',
    });
    toast.success('已重新提交音色克隆任务');
  }

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <PageHeader
        eyebrow="Voice clone"
        title="音色克隆"
        description="上传一段参考音色，让 Qwen3-TTS 克隆该音色朗读指定文案。"
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
        <Field label="说话内容" required hint="会被克隆音色朗读的文案。">
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="输入需要朗读的说话内容" />
        </Field>
        <Field label="参考音色" required hint="用于克隆的参考语音（尽量清晰、无背景噪声）。">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> 上传参考音色
              </Button>
              <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={onPick} />
            </div>
            {refVoice ? <FilePill onRemove={() => setRefVoice(null)}>参考音色：{refVoice.name}</FilePill> : null}
          </div>
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" size="md" loading={busy} disabled={busy || !projectId} onClick={generate}>
            <Sparkles size={14} />
            生成克隆音色
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
          emptyDescription="上传参考音色并填写说话内容后点击生成，克隆音色会出现在这里。"
        />
      </section>
    </div>
  );
}
