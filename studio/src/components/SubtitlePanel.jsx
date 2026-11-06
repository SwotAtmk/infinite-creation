import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, Wrench } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Field, Input, Progress, Segmented, Select, Switch } from './ui.jsx';
import { useToast } from './toast.jsx';

const MODE_OPTIONS = [
  { value: 'script', label: '剧本台词（经典）' },
  { value: 'whisper', label: '本地识别（whisper）' },
  { value: 'api', label: '外部服务（audio2srt API）' },
];

const MODEL_OPTIONS = [
  { value: 'large-v3-turbo', label: '极速版 large-v3-turbo' },
  { value: 'large-v3', label: '专业版 large-v3' },
];

const LANG_OPTIONS = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

const SERVICE_REPO = 'https://github.com/SwotAtmk/audio2srt_service';

// 字幕面板：三种模式 —— 经典剧本台词 / 本地 whisper / 外部 audio2srt 服务。
// 本地模式的安装与模型下载都在后端后台任务里跑，这里只负责发起、展示进度、取消。
export default function SubtitlePanel({ cfg, setCfg }) {
  const toast = useToast();
  const sub = cfg.subtitle || {};
  const mode = sub.mode === 'whisper' || sub.mode === 'api' ? sub.mode : 'script';
  const model = MODEL_OPTIONS.some((o) => o.value === sub.model) ? sub.model : 'large-v3-turbo';
  const [status, setStatus] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState('');
  const [apiTest, setApiTest] = useState(null);
  const [apiTesting, setApiTesting] = useState(false);

  const patch = (p) => setCfg({ ...cfg, subtitle: { ...sub, ...p } });

  const load = useCallback(() => {
    api
      .get('/api/subtitle/status')
      .then((s) => {
        setStatus(s);
        setLoadErr('');
      })
      .catch((e) => setLoadErr(e.message || '读取失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tasks = status?.tasks || {};
  const running = Object.values(tasks).find((t) => t && t.status === 'running') || null;
  const failed = Object.values(tasks).find((t) => t && t.status === 'error') || null;
  const anyRunning = !!running;

  // 只有「有任务在跑」才轮询；用布尔依赖，避免每次拿到新对象就把定时器重建一遍。
  useEffect(() => {
    if (!anyRunning) return undefined;
    const id = setInterval(load, 1200);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  async function start(payload) {
    setBusy(payload.target);
    try {
      await api.post('/api/subtitle/install', payload);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  async function testApi() {
    setApiTesting(true);
    setApiTest(null);
    try {
      setApiTest(await api.post('/api/subtitle/test', { baseUrl: sub.apiBaseUrl || '' }));
    } catch (e) {
      setApiTest({ ok: false, compatible: false, error: e.message });
    } finally {
      setApiTesting(false);
    }
  }

  const py = status?.python;
  const env = status?.env;
  const m = status?.models?.[model];
  const envTask = tasks.env;
  const modelTask = tasks[model];

  return (
    <>
      <Segmented value={mode} onChange={(v) => patch({ mode: v })} options={MODE_OPTIONS} />
      <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
        {mode === 'whisper'
          ? '本地识别：导出时按成片实际音轨识别，断句跟随语音停顿。需要本机 Python 3.9+ 与模型，首次使用自动安装。'
          : mode === 'api'
            ? '外部服务：把本章音轨上传到已部署的 audio2srt 服务，由它转写并返回 SRT。本机不需要 Python。'
            : '经典模式：直接用分镜台词 / 旁白生成字幕，不调用 Python、不下模型；没有 Python 环境的机器请保持这一档。'}
      </p>

      {mode !== 'script' ? (
        <>
          <Segmented value={model} onChange={(v) => patch({ model: v })} options={MODEL_OPTIONS} />
          <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
            极速版约 1.6GB，识别更快，适合日常；专业版约 3.0GB，更准但更慢。默认极速版。
          </p>
        </>
      ) : null}

      {mode === 'whisper' ? (
        <>
          {status && py && !py.ok ? (
            <p className="m-0 rounded-xl border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--fg-3)]">
              未检测到 Python。点「安装 / 修复环境」会自动下载一份便携 Python（约 25MB）到 data/subtitle/ 并装好识别环境；
              也可以先自己安装 Python 3.9+，或在下方填写解释器路径。在此之前导出会自动回退为剧本台词字幕。
            </p>
          ) : null}

          <div className="grid gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3.5">
            <StatusRow
              label="Python"
              text={py && py.ok ? (py.source === 'bundled' ? '内置运行时 · ' + py.version : py.path + ' · ' + py.version) : ''}
              hint={py && !py.ok ? py.error : ''}
              tone={py && py.ok ? 'success' : 'neutral'}
              badge={py && py.ok ? (py.source === 'bundled' ? '内置' : '可用') : '不可用'}
            />
            <StatusRow
              label="运行环境"
              text={env && env.ready ? env.venvPath : ''}
              hint={!env && !loadErr ? '检测中…' : ''}
              tone={env && env.ready ? 'success' : envTask && envTask.status === 'error' ? 'danger' : envTask ? 'accent' : 'neutral'}
              badge={
                env && env.ready
                  ? '已就绪'
                  : envTask && envTask.status === 'running'
                    ? '安装中 ' + (envTask.percent || 0) + '%'
                    : envTask && envTask.status === 'error'
                      ? '安装失败'
                      : '未安装'
              }
            />
            <StatusRow
              label={'模型 · ' + (m ? m.label : model)}
              text={m && m.downloaded ? (m.bytes / 1048576).toFixed(0) + ' MB' : ''}
              hint={m && !m.downloaded ? '约 ' + (m ? m.sizeMb : 0) + ' MB' : ''}
              tone={m && m.downloaded ? 'success' : modelTask && modelTask.status === 'error' ? 'danger' : modelTask ? 'accent' : 'neutral'}
              badge={
                m && m.downloaded
                  ? '已下载'
                  : modelTask && modelTask.status === 'running'
                    ? '下载中 ' + (modelTask.percent || 0) + '%'
                    : modelTask && modelTask.status === 'error'
                      ? '下载失败'
                      : '未下载'
              }
            />
            {running ? (
              <div className="flex flex-col gap-1.5 pt-1">
                <Progress value={running.percent || 0} />
                <span className="break-all text-[11px] text-[var(--fg-3)]">{running.detail}</span>
              </div>
            ) : null}
            {!running && failed && failed.error ? (
              <span className="break-all text-[11px] text-[var(--danger)]">{failed.error}</span>
            ) : null}
            {loadErr ? <span className="text-[11px] text-[var(--danger)]">{loadErr}</span> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="md" disabled={anyRunning || busy === 'env'} onClick={() => start({ target: 'env' })}>
              <Wrench size={14} /> 安装 / 修复环境
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={anyRunning || !!busy || !!(m && m.downloaded)}
              onClick={() => start({ target: 'model', model })}
            >
              <Download size={14} /> 下载模型
            </Button>
            {anyRunning ? (
              <Button variant="ghost" size="md" onClick={() => start({ target: 'cancel' })}>
                取消任务
              </Button>
            ) : null}
            <Button variant="ghost" size="md" onClick={load}>
              <RefreshCw size={14} /> 重新检测
            </Button>
          </div>

          <Field label="Python 解释器路径（可选）" hint="留空自动探测；需 Python 3.9+，例如 /opt/homebrew/bin/python3.12">
            <Input value={sub.pythonPath || ''} onChange={(e) => patch({ pythonPath: e.target.value })} placeholder="留空自动探测" />
          </Field>

          <Switch
            checked={sub.autoSetup !== false}
            onChange={(v) => patch({ autoSetup: v })}
            label="首次使用时自动安装环境并下载模型"
            hint="关闭后，环境或模型未就绪时导出会直接回退为剧本字幕。"
          />

          <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
            识别耗时随视频时长增长；环境与模型只需要装一次。本机没有 Python 时会自动下载便携 Python 运行时
            （约 25MB，解压到 data/subtitle/，不影响系统 Python）；pip 走阿里云镜像。
          </p>
        </>
      ) : null}

      {mode === 'api' ? (
        <>
          <Field
            label="服务地址"
            hint={
              <span>
                需要先部署{' '}
                <a href={SERVICE_REPO} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                  audio2srt_service（{SERVICE_REPO}）
                </a>
                （FastAPI）：<code className="font-mono text-[10.5px]">python main.py</code> 默认监听 8000，接口文档在
                <code className="font-mono text-[10.5px]"> /docs</code>。服务端需自行安装 whisper 并准备模型，本机不需要 Python。
              </span>
            }
          >
            <div className="flex flex-wrap gap-2">
              <Input
                value={sub.apiBaseUrl || ''}
                onChange={(e) => {
                  patch({ apiBaseUrl: e.target.value });
                  setApiTest(null);
                }}
                placeholder="http://127.0.0.1:8000"
                className="min-w-[240px] flex-1"
              />
              <Button variant="secondary" size="md" loading={apiTesting} onClick={testApi}>
                测试连接
              </Button>
            </div>
          </Field>

          {apiTest ? (
            apiTest.compatible ? (
              <p className="m-0 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--success)]">
                <Badge tone="success" dot>接口匹配</Badge>
                {apiTest.title} v{apiTest.serviceVersion || apiTest.apiVersion || '?'}
                {' · '}模型：{apiTest.models && apiTest.models.length ? apiTest.models.join(' / ') : '服务端未报告'}
                {' · '}ffmpeg {apiTest.ffmpegOk ? '正常' : '异常'}
                {apiTest.queueWorkers != null ? ' · 并发 ' + apiTest.queueWorkers : ''}
              </p>
            ) : apiTest.ok ? (
              <p className="m-0 text-[11.5px] text-[var(--danger)]">
                服务可以连接，但接口不匹配 audio2srt：{apiTest.error}
              </p>
            ) : (
              <p className="m-0 break-all text-[11.5px] text-[var(--danger)]">连接失败：{apiTest.error}</p>
            )
          ) : (
            <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
              先点「测试连接」确认服务在线且接口匹配；未通过时导出会自动回退为剧本台词字幕。
            </p>
          )}

          <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
            导出时会把本章拼接后的音轨（16kHz 单声道 WAV）上传到该服务，轮询任务进度，完成后取回 SRT 烧录。
            接口：<code className="font-mono text-[10.5px]">POST /api/v1/transcriptions</code>、
            <code className="font-mono text-[10.5px]">GET /api/v1/transcriptions/{'{task_id}'}</code>、
            <code className="font-mono text-[10.5px]">GET /api/v1/transcriptions/{'{task_id}'}/srt</code>。
          </p>
        </>
      ) : null}

      {mode !== 'script' ? (
        <Field label="识别语言" hint="自动检测适合中英混合；固定语言可减少误判。">
          <Select value={sub.language || 'auto'} onChange={(v) => patch({ language: v })} items={LANG_OPTIONS} />
        </Field>
      ) : null}

      {mode === 'script' ? (
        <p className="m-0 rounded-xl border border-[var(--line)] bg-white/[0.015] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--fg-4)]">
          经典模式不会读取任何 Python 环境，也不会下载模型。如果之后想用语音识别，切换上方模式后按提示完成
          本地环境或外部服务配置即可。
        </p>
      ) : null}
    </>
  );
}

function StatusRow({ label, text, hint, badge, tone }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[11.5px] text-[var(--fg-4)]">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[10.5px] text-[var(--fg-2)]" title={text || hint}>
          {text || hint || '—'}
        </span>
        <Badge tone={tone} dot>
          {badge}
        </Badge>
      </span>
    </div>
  );
}
