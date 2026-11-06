// 自动字幕：本地 whisper 环境 + 模型管理 + 语音识别。
//
// 方案照搬 PycharmProjects/audio2srt：
//   · 引擎 openai-whisper（PyTorch），首次使用在本机建 venv 并 pip 安装（走阿里云镜像）；
//   · 模型为 OpenAI 官方 .pt：large-v3-turbo（极速版，默认）/ large-v3（专业版）；
//   · 模型落盘 data/subtitle/models，带 .download 临时文件 + SHA256 校验 + 原子重命名。
//
// 导出成片时由 lib/agent/tools.js 与 app/api/projects/[id]/export/route.js 调用 buildSubtitles()，
// 把本章所有分镜的音轨按 mergeVideos 的顺序拼成一条 WAV 再识别，保证时间轴与成片一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR, ROOT, loadConfig } from './config.js';
import { extractConcatAudio } from './ffmpeg.js';
import { segmentsToSrt, buildSrt } from './srt.js';
import { logger } from './logger.js';

// 国内直连官方源装 torch 极易超时；两处 pip install 都必须带 -i。
const PIP_INDEX = process.env.IC_PIP_INDEX || 'https://mirrors.aliyun.com/pypi/simple';

export const SUBTITLE_MODELS = {
  'large-v3-turbo': {
    label: '极速版',
    file: 'large-v3-turbo.pt',
    sizeMb: 1560,
    url: 'https://openaipublic.azureedge.net/main/whisper/models/aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a/large-v3-turbo.pt',
  },
  'large-v3': {
    label: '专业版',
    file: 'large-v3.pt',
    sizeMb: 2950,
    url: 'https://openaipublic.azureedge.net/main/whisper/models/e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb/large-v3.pt',
  },
};
export const SUBTITLE_MODEL_DEFAULT = 'large-v3-turbo';

export const SUBTITLE_LANGUAGES = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

const TASK_KEY = '__icSubtitleTasks';
const PY_CACHE_KEY = '__icSubtitlePythonCache';

// 目录全部挂在 DATA_DIR 下，容器/测试可用 IC_DATA_DIR 或 IC_SUBTITLE_DIR 重定向。
export function subtitlePaths() {
  const root = process.env.IC_SUBTITLE_DIR ? path.resolve(process.env.IC_SUBTITLE_DIR) : path.join(DATA_DIR, 'subtitle');
  const venvDir = path.join(root, 'venv');
  const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
  return {
    root,
    venvDir,
    venvPython,
    modelDir: path.join(root, 'models'),
    scriptPath: path.join(ROOT, 'scripts', 'subtitle', 'transcribe.py'),
  };
}

// 配置归一化：手改坏的 mode / model / language 一律回默认值，不让设置页与导出流程抛错。
// mode：script = 经典剧本台词（零依赖）；whisper = 语音识别（需本机 Python）。
export function resolveSubtitleConfig(cfg = loadConfig()) {
  const raw = cfg && cfg.subtitle && typeof cfg.subtitle === 'object' && !Array.isArray(cfg.subtitle) ? cfg.subtitle : {};
  const mode = raw.mode === 'whisper' ? 'whisper' : 'script';
  const model = Object.prototype.hasOwnProperty.call(SUBTITLE_MODELS, raw.model) ? raw.model : SUBTITLE_MODEL_DEFAULT;
  const language = SUBTITLE_LANGUAGES.some((l) => l.value === raw.language) ? raw.language : 'auto';
  return {
    mode,
    model,
    language,
    autoSetup: raw.autoSetup !== false,
    pythonPath: String(raw.pythonPath || '').trim(),
  };
}

// ---------- Python 探测 ----------

function resolveBin(cmd) {
  if (!cmd || cmd.includes('/') || cmd.includes('\\')) return cmd;
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 5000 });
    if (!r.error && r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) return first;
    }
  } catch { /* 找不到就按原命令名交给 spawn 解析 */ }
  return cmd;
}

function probePython(cmd, prefixArgs = []) {
  try {
    const r = spawnSync(cmd, [...prefixArgs, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status !== 0) return null;
    const version = String(r.stdout || '').trim();
    const m = /^(\d+)\.(\d+)$/.exec(version);
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    // openai-whisper 依赖的 torch 只提供 3.9+ 的轮子
    if (major < 3 || (major === 3 && minor < 9)) return null;
    return { command: cmd, prefixArgs, version };
  } catch {
    return null;
  }
}

// 候选顺序：显式指定 → 环境变量 → 3.12/3.11/3.10（torch & numba 轮子最稳）→ 3.13 → Homebrew/系统路径 → python3/python。
function pythonCandidates() {
  const list = [];
  const push = (cmd, args = []) => {
    if (!cmd) return;
    if (!list.some((c) => c.command === cmd && c.prefixArgs.join(' ') === args.join(' '))) list.push({ command: cmd, prefixArgs: args });
  };
  push(process.env.IC_SUBTITLE_PYTHON);
  if (process.platform === 'win32') {
    push('py', ['-3']);
    push('python3.12'); push('python3.11'); push('python3.10'); push('python3.13');
  } else {
    push('python3.12'); push('python3.11'); push('python3.10'); push('python3.13');
    if (process.platform === 'darwin') {
      push('/opt/homebrew/bin/python3');
      push('/usr/local/bin/python3');
    }
  }
  push('python3');
  push('python');
  return list;
}

// 探测结果缓存 30s：状态接口会被前端 1.2s 轮询一次，不能每次都 spawn。
export function detectPython(preferred = '') {
  const want = String(preferred || '').trim();
  const cache = globalThis[PY_CACHE_KEY] || (globalThis[PY_CACHE_KEY] = { key: '', at: 0, value: null });
  if (cache.value && cache.key === want && Date.now() - cache.at < 30_000) return cache.value;

  const remember = (v) => {
    cache.key = want;
    cache.at = Date.now();
    cache.value = v;
    return v;
  };

  if (want) {
    const hit = probePython(want);
    if (!hit) {
      return remember({ ok: false, path: want, version: '', error: '指定的 Python 不可用（需 3.9+）：' + want });
    }
    return remember({ ok: true, path: resolveBin(hit.command), version: hit.version, error: '' });
  }

  for (const c of pythonCandidates()) {
    const hit = probePython(c.command, c.prefixArgs);
    if (hit) return remember({ ok: true, path: resolveBin(hit.command), version: hit.version, error: '' });
  }
  return remember({ ok: false, path: '', version: '', error: '未检测到 Python 3.9+，请先安装 Python 或填写解释器路径' });
}

// ---------- 环境 / 模型状态 ----------

// 用文件系统判断 whisper 是否装好（venv/lib/pythonX.Y/site-packages/whisper），
// 不做 `import whisper`：那会加载 torch，既慢又会卡住事件循环。
function findWhisperPackage(venvDir) {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(venvDir, 'Lib', 'site-packages', 'whisper'));
  } else {
    try {
      for (const d of fs.readdirSync(path.join(venvDir, 'lib'))) {
        if (/^python\d+\.\d+$/.test(d)) candidates.push(path.join(venvDir, 'lib', d, 'site-packages', 'whisper'));
      }
    } catch { /* venv 还没建 */ }
  }
  return candidates.find((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }) || '';
}

export function envStatus() {
  const p = subtitlePaths();
  const hasPython = fs.existsSync(p.venvPython);
  const pkg = hasPython ? findWhisperPackage(p.venvDir) : '';
  return { ready: !!pkg, venvPath: p.venvDir, pythonPath: p.venvPython, packagePath: pkg, error: '' };
}

export function modelStatus(name) {
  const m = SUBTITLE_MODELS[name];
  if (!m) return null;
  const file = path.join(subtitlePaths().modelDir, m.file);
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch { /* 未下载 */ }
  // 小于 1MB 视为残留下载文件，不算已下载
  return { label: m.label, downloaded: bytes > 1024 * 1024, sizeMb: m.sizeMb, bytes, path: file };
}

// ---------- 后台任务（单例，挂 globalThis 防止多 route 实例各存一份） ----------

function taskStore() {
  if (!globalThis[TASK_KEY]) globalThis[TASK_KEY] = { tasks: {}, pending: {}, abort: null };
  return globalThis[TASK_KEY];
}

export function subtitleTasks() {
  const store = taskStore();
  const out = { env: null };
  for (const name of Object.keys(SUBTITLE_MODELS)) out[name] = null;
  for (const [k, v] of Object.entries(store.tasks)) out[k] = v;
  return out;
}

function runningTarget() {
  const store = taskStore();
  const hit = Object.entries(store.tasks).find(([, t]) => t && t.status === 'running');
  return hit ? hit[0] : '';
}

function startTask(target, runner) {
  const store = taskStore();
  const busy = runningTarget();
  if (busy) throw Object.assign(new Error('已有字幕任务在执行（' + busy + '），请等待完成或先取消'), { code: 'SUBTITLE_BUSY' });
  const task = { target, status: 'running', percent: 0, detail: '准备中…', error: '', startedAt: Date.now() };
  store.tasks[target] = task;
  const ac = new AbortController();
  store.abort = ac;
  const report = (o) => {
    if (!o) return;
    if (o.percent != null && Number.isFinite(Number(o.percent))) {
      task.percent = Math.max(0, Math.min(100, Math.round(Number(o.percent))));
    }
    if (o.detail) task.detail = String(o.detail);
  };
  const p = (async () => {
    try {
      await runner({ task, report, signal: ac.signal });
      task.status = 'done';
      task.percent = 100;
      task.detail = '完成';
    } catch (e) {
      task.status = 'error';
      task.error = e && e.message ? e.message : String(e);
      task.detail = '失败：' + task.error;
      logger.warn('字幕任务失败', { target, error: task.error });
    } finally {
      if (store.abort === ac) store.abort = null;
      delete store.pending[target];
    }
  })();
  store.pending[target] = p;
  return task;
}

// 已有同目标任务在跑就直接复用；其它目标在跑则报错（同一时刻只允许一个）。
async function runOrJoin(target, runner) {
  const store = taskStore();
  if (store.pending[target]) return store.pending[target];
  startTask(target, runner);
  return store.pending[target];
}

export function startEnvInstall() {
  return startTask('env', (ctx) => installEnv(ctx));
}

export function startModelDownload(name) {
  if (!SUBTITLE_MODELS[name]) throw new Error('未知字幕模型：' + name);
  return startTask(name, (ctx) => downloadModel(name, ctx));
}

export function cancelSubtitleTask() {
  const store = taskStore();
  if (!store.abort) return false;
  const target = runningTarget();
  try { store.abort.abort(); } catch { /* 已结束 */ }
  if (target && store.tasks[target]) store.tasks[target].detail = '正在取消…';
  return true;
}

// ---------- 子进程 ----------

function childEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
}

// 跑 pip / venv：stdout+stderr 按行回调（用于把 pip 的实时输出写进任务 detail）。
function runCommand(cmd, args, { onLine, timeoutMs = 60 * 60 * 1000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    } catch (e) {
      reject(new Error(cmd + ' 启动失败: ' + e.message));
      return;
    }
    let buf = '';
    let tail = '';
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      fail(new Error('已停止：' + cmd + ' 已被终止'));
    };
    const onData = (d) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-2000);
      buf += s;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (t && onLine) onLine(t);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      fail(new Error(cmd + ' 执行超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => fail(new Error(cmd + ' 启动失败: ' + e.message)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve(tail);
      else reject(new Error(cmd + ' 退出码 ' + code + (tail ? '：' + tail : '')));
    });
  });
}

// ---------- 环境安装 ----------

async function installEnv({ report, signal }) {
  const cfg = resolveSubtitleConfig();
  const py = detectPython(cfg.pythonPath);
  if (!py.ok) throw new Error(py.error);
  const p = subtitlePaths();
  fs.mkdirSync(p.root, { recursive: true });

  if (!fs.existsSync(p.venvPython)) {
    report({ detail: '创建 Python 虚拟环境…' });
    await runCommand(py.path, ['-m', 'venv', p.venvDir], { signal });
  }
  report({ percent: 10, detail: '升级 pip（阿里云镜像）…' });
  await runCommand(p.venvPython, ['-m', 'pip', 'install', '-i', PIP_INDEX, '-U', 'pip'], {
    signal,
    onLine: (l) => report({ detail: '升级 pip：' + l.slice(0, 120) }),
  });
  report({ percent: 20, detail: '安装 openai-whisper（首次会下载 torch，约数百 MB）…' });
  await runCommand(p.venvPython, ['-m', 'pip', 'install', '-i', PIP_INDEX, '-U', 'openai-whisper'], {
    signal,
    onLine: (l) => report({ percent: 25, detail: '安装依赖：' + l.slice(0, 120) }),
  });

  const st = envStatus();
  if (!st.ready) throw new Error('安装结束但未检测到 whisper 包，请检查 pip 输出或网络');
  report({ percent: 100, detail: '运行环境已就绪' });
  logger.info('字幕运行环境安装完成', { venv: p.venvDir });
}

// ---------- 模型下载 ----------

async function downloadModel(name, { report, signal }) {
  const m = SUBTITLE_MODELS[name];
  const p = subtitlePaths();
  fs.mkdirSync(p.modelDir, { recursive: true });
  const dest = path.join(p.modelDir, m.file);
  const tmp = dest + '.download';
  // URL 倒数第二段就是 OpenAI 官方公布的 SHA256
  const expected = String(m.url).split('/').slice(-2)[0].toLowerCase();

  report({ detail: '连接模型服务器…' });
  let res;
  try {
    res = await fetch(m.url, { signal, redirect: 'follow' });
  } catch (e) {
    throw new Error('模型下载失败：' + (e && e.message ? e.message : String(e)));
  }
  if (!res.ok || !res.body) throw new Error('模型下载失败 HTTP ' + res.status);

  const total = Number(res.headers.get('content-length')) || m.sizeMb * 1024 * 1024;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPct = -1;

  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((received * 100) / total) : 0;
      if (pct > lastPct) {
        lastPct = pct;
        report({
          percent: pct,
          detail: '下载中 ' + Math.round(received / 1048576) + '/' + Math.round(total / 1048576) + ' MB',
        });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const digest = hash.digest('hex');
    if (/^[0-9a-f]{64}$/.test(expected) && digest !== expected) {
      throw new Error('模型校验失败（SHA256 不匹配），请重试');
    }
    fs.renameSync(tmp, dest);
    report({ percent: 100, detail: '模型已就绪' });
    logger.info('字幕模型下载完成', { model: name, bytes: received });
  } catch (e) {
    try { out.destroy(); } catch { /* 已关闭 */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    if (e && (e.name === 'AbortError' || e.message === 'This operation was aborted')) throw new Error('已取消下载');
    throw e;
  }
}

// ---------- 对外：确保就绪 ----------

export async function ensureRuntime({ onProgress, allowInstall = true } = {}) {
  if (envStatus().ready) return;
  if (!allowInstall) throw new Error('字幕运行环境未安装：请到「设置 → 字幕与语音识别」安装，或打开自动安装');
  onProgress && onProgress('首次使用：安装 Python 环境（pip 走阿里云镜像）');
  await runOrJoin('env', (ctx) => installEnv({
    ...ctx,
    report: (o) => {
      ctx.report(o);
      if (o && o.detail && onProgress) onProgress(o.detail);
    },
  }));
  const t = taskStore().tasks.env;
  if (t && t.status === 'error') throw new Error(t.error);
  if (!envStatus().ready) throw new Error('字幕运行环境安装失败');
}

export async function ensureModel(name, { onProgress, allowInstall = true } = {}) {
  const m = SUBTITLE_MODELS[name];
  if (!m) throw new Error('未知字幕模型：' + name);
  const file = path.join(subtitlePaths().modelDir, m.file);
  if (fs.existsSync(file)) return file;
  if (!allowInstall) throw new Error('字幕模型未下载：' + m.label + ' ' + name);
  onProgress && onProgress('首次使用：下载字幕模型 ' + m.label + ' ' + name + '（约 ' + m.sizeMb + ' MB）');
  await runOrJoin(name, (ctx) => downloadModel(name, {
    ...ctx,
    report: (o) => {
      ctx.report(o);
      if (o && o.detail && onProgress) onProgress(o.detail);
    },
  }));
  const t = taskStore().tasks[name];
  if (t && t.status === 'error') throw new Error(t.error);
  if (!fs.existsSync(file)) throw new Error('字幕模型下载失败');
  return file;
}

// ---------- 转写 ----------

function transcribeWav(wavPath, { modelPath, language, onProgress, isAborted } = {}) {
  return new Promise((resolve, reject) => {
    const p = subtitlePaths();
    if (!fs.existsSync(p.scriptPath)) {
      reject(new Error('缺少转写脚本：' + p.scriptPath));
      return;
    }
    if (!fs.existsSync(p.venvPython)) {
      reject(new Error('字幕运行环境未安装'));
      return;
    }
    let child;
    try {
      child = spawn(p.venvPython, [p.scriptPath, wavPath, '--model', modelPath, '--language', language || 'auto'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
    } catch (e) {
      reject(new Error('无法启动语音识别：' + e.message));
      return;
    }
    let buf = '';
    let errTail = '';
    let segments = null;
    let scriptError = '';
    let settled = false;
    let timer;
    let aborter;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(aborter);
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      fail(new Error('语音识别超时（180 分钟）'));
    }, 180 * 60 * 1000);
    aborter = setInterval(() => {
      if (!isAborted || !isAborted()) return;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      fail(new Error('已停止：语音识别已终止'));
    }, 800);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }
        if (msg.type === 'stage') {
          if (onProgress) onProgress(msg.stage === 'load' ? '加载模型…' : '识别中…');
        } else if (msg.type === 'progress') {
          const pct = msg.total > 0 ? Math.min(99, Math.round((Number(msg.at) * 100) / Number(msg.total))) : 0;
          if (onProgress) onProgress('识别中 ' + pct + '%');
        } else if (msg.type === 'done') {
          segments = Array.isArray(msg.segments) ? msg.segments : [];
        } else if (msg.type === 'error') {
          scriptError = msg.message || '未知错误';
        }
      }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2000); });
    child.on('error', (e) => fail(new Error('无法启动语音识别：' + e.message)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (scriptError) return reject(new Error('语音识别失败：' + scriptError));
      if (code !== 0) return reject(new Error('语音识别进程退出码 ' + code + (errTail ? '：' + errTail : '')));
      if (!segments) return reject(new Error('语音识别没有返回结果' + (errTail ? '：' + errTail : '')));
      resolve(segments);
    });
  });
}

// ---------- 对外入口 ----------

// 语音识别：只做 ASR，不关心模式（调用方用 resolveSubtitles 统一决策）。
export async function buildSubtitles({ projectId, inputs, onProgress, isAborted } = {}) {
  const cfg = resolveSubtitleConfig();
  const report = (d) => { if (d && onProgress) onProgress(String(d)); };
  if (!inputs || !inputs.length) return { srt: '', cues: 0, model: cfg.model, language: cfg.language };

  await ensureRuntime({ onProgress: report, allowInstall: cfg.autoSetup });
  const modelPath = await ensureModel(cfg.model, { onProgress: report, allowInstall: cfg.autoSetup });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-asr-'));
  const wav = path.join(tmpDir, 'audio.wav');
  try {
    report('提取音轨…');
    await extractConcatAudio(inputs, wav, { isAborted });
    report('开始语音识别（' + SUBTITLE_MODELS[cfg.model].label + ' ' + cfg.model + '）');
    const segments = await transcribeWav(wav, {
      modelPath,
      language: cfg.language,
      onProgress: report,
      isAborted,
    });
    const srt = segmentsToSrt(segments);
    logger.info('字幕识别完成', { projectId, model: cfg.model, cues: segments.length });
    return { srt, cues: segments.length, model: cfg.model, language: cfg.language };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// 导出链路统一入口：按配置选模式。
//   script  → 直接用分镜台词/旁白（零依赖，没装 Python 的用户走这条）
//   whisper → 语音识别；环境/模型/识别失败时自动回退剧本台词，不阻断导出
export async function resolveSubtitles({ projectId, inputs, shots, onProgress, isAborted } = {}) {
  const cfg = resolveSubtitleConfig();
  if (cfg.mode !== 'whisper') {
    return { srt: buildSrt(shots || []), cues: 0, model: '', language: cfg.language, mode: 'script', fallback: false };
  }
  try {
    const r = await buildSubtitles({ projectId, inputs, onProgress, isAborted });
    return { ...r, mode: 'whisper', fallback: false };
  } catch (e) {
    if (isAborted && isAborted()) throw e;
    const msg = e && e.message ? e.message : String(e);
    if (onProgress) onProgress('语音识别不可用，回退剧本字幕：' + msg);
    return { srt: buildSrt(shots || []), cues: 0, model: cfg.model, language: cfg.language, mode: 'whisper', fallback: true, error: msg };
  }
}

// ---------- 状态汇总（设置页） ----------

export function subtitleStatus() {
  const cfg = resolveSubtitleConfig();
  const models = {};
  for (const [name, m] of Object.entries(SUBTITLE_MODELS)) {
    const { url, ...meta } = m;
    models[name] = { ...meta, ...modelStatus(name) };
  }
  return {
    mode: cfg.mode,
    model: cfg.model,
    language: cfg.language,
    autoSetup: cfg.autoSetup,
    pythonPath: cfg.pythonPath,
    languages: SUBTITLE_LANGUAGES,
    python: detectPython(cfg.pythonPath),
    env: envStatus(),
    models,
    tasks: subtitleTasks(),
  };
}
