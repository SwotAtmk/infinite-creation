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

// 本机没有 Python 时自动装的便携运行时（python-build-standalone 的 install_only 构建）：
// 解压即用、不需要管理员权限，也不会污染系统 Python。版本与 tag 固定，保证下载地址稳定。
const PY_RUNTIME_VERSION = '3.12.16';
const PY_RUNTIME_TAG = '20261026';
const PY_RUNTIME_BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download';

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
    runtimeDir: path.join(root, 'python-runtime'),
    scriptPath: path.join(ROOT, 'scripts', 'subtitle', 'transcribe.py'),
  };
}

// python-build-standalone 按平台/架构分发的资产名；不支持的平台返回空串（由调用方提示手动安装）。
export function runtimeAssetName() {
  const plat = process.platform;
  const arch = process.arch;
  const suffixMap = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  };
  const suffix = suffixMap[plat + '-' + arch];
  return suffix ? 'cpython-' + PY_RUNTIME_VERSION + '+' + PY_RUNTIME_TAG + '-' + suffix + '-install_only.tar.gz' : '';
}

// 解压后 install_only 包内固定是 python/ 目录（Windows 是 python/python.exe）。
export function bundledPythonPath() {
  const base = path.join(subtitlePaths().runtimeDir, 'python');
  return process.platform === 'win32' ? path.join(base, 'python.exe') : path.join(base, 'bin', 'python3');
}

// 配置归一化：手改坏的 mode / model / language 一律回默认值，不让设置页与导出流程抛错。
// mode：script = 经典剧本台词（零依赖）；whisper = 本地语音识别；api = 外部 audio2srt 服务。
export function resolveSubtitleConfig(cfg = loadConfig()) {
  const raw = cfg && cfg.subtitle && typeof cfg.subtitle === 'object' && !Array.isArray(cfg.subtitle) ? cfg.subtitle : {};
  const mode = raw.mode === 'whisper' || raw.mode === 'api' ? raw.mode : 'script';
  const model = Object.prototype.hasOwnProperty.call(SUBTITLE_MODELS, raw.model) ? raw.model : SUBTITLE_MODEL_DEFAULT;
  const language = SUBTITLE_LANGUAGES.some((l) => l.value === raw.language) ? raw.language : 'auto';
  return {
    mode,
    model,
    language,
    autoSetup: raw.autoSetup !== false,
    pythonPath: String(raw.pythonPath || '').trim(),
    apiBaseUrl: normalizeApiBase(raw.apiBaseUrl) || 'http://127.0.0.1:8000',
  };
}

// 外部服务地址归一化：补协议、去尾斜杠；空串返回 ''。
export function normalizeApiBase(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : 'http://' + s;
  return withScheme.replace(/\/+$/, '');
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
      return remember({ ok: false, path: want, version: '', source: 'none', error: '指定的 Python 不可用（需 3.9+）：' + want });
    }
    return remember({ ok: true, path: resolveBin(hit.command), version: hit.version, source: 'custom', error: '' });
  }

  // 先看本应用自己装的便携运行时：版本固定，不会随系统环境变化。
  const bundled = bundledPythonPath();
  if (fs.existsSync(bundled)) {
    const hit = probePython(bundled);
    if (hit) return remember({ ok: true, path: bundled, version: hit.version, source: 'bundled', error: '' });
  }

  for (const c of pythonCandidates()) {
    const hit = probePython(c.command, c.prefixArgs);
    if (hit) return remember({ ok: true, path: resolveBin(hit.command), version: hit.version, source: 'system', error: '' });
  }
  return remember({ ok: false, path: '', version: '', source: 'none', error: '未检测到 Python 3.9+（可点「安装 / 修复环境」自动下载便携运行时）' });
}

// 装完便携运行时 / 用户改了路径后立刻生效，不必等 30s 缓存过期。
export function clearPythonCache() {
  globalThis[PY_CACHE_KEY] = { key: '', at: 0, value: null };
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
  let py = detectPython(cfg.pythonPath);
  let progress = 5;
  if (!py.ok) {
    // 用户显式指定了解释器却不可用：按他填的报错，不擅自换成别的 Python。
    if (cfg.pythonPath) throw new Error(py.error);
    // 本机没有任何 Python：自动下载便携运行时（解压即用，不动系统）。
    py = await ensurePortablePython({ report, signal });
    progress = 82;
  }
  const p = subtitlePaths();
  fs.mkdirSync(p.root, { recursive: true });

  if (!fs.existsSync(p.venvPython)) {
    report({ percent: progress, detail: '用 ' + py.path + ' 创建虚拟环境…' });
    await runCommand(py.path, ['-m', 'venv', p.venvDir], { signal });
  }
  report({ percent: progress + 3, detail: '升级 pip（阿里云镜像）…' });
  await runCommand(p.venvPython, ['-m', 'pip', 'install', '-i', PIP_INDEX, '-U', 'pip'], {
    signal,
    onLine: (l) => report({ detail: '升级 pip：' + l.slice(0, 120) }),
  });
  report({ percent: progress + 6, detail: '安装 openai-whisper（首次会下载 torch，约数百 MB）…' });
  await runCommand(p.venvPython, ['-m', 'pip', 'install', '-i', PIP_INDEX, '-U', 'openai-whisper'], {
    signal,
    onLine: (l) => report({ percent: progress + 9, detail: '安装依赖：' + l.slice(0, 120) }),
  });

  const st = envStatus();
  if (!st.ready) throw new Error('安装结束但未检测到 whisper 包，请检查 pip 输出或网络');
  report({ percent: 100, detail: '运行环境已就绪' });
  logger.info('字幕运行环境安装完成', { venv: p.venvDir, python: py.path, source: py.source });
}

// ---------- 下载 ----------

// 流式下载到文件：写 .download 临时文件、边下边算 SHA256、完成校验后原子重命名。
async function downloadToFile(url, dest, { onProgress, signal, expectedSha256 = '', timeoutMs = 60 * 60 * 1000 } = {}) {
  const tmp = dest + '.download';
  const controller = new AbortController();
  const onAbort = () => { try { controller.abort(); } catch { /* 已结束 */ } };
  if (signal) {
    if (signal.aborted) throw new Error('已取消下载');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* 已结束 */ } }, timeoutMs);
  let out;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(tmp);
    let received = 0;
    let lastPct = -1;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      if (onProgress && total > 0) {
        const pct = Math.floor((received * 100) / total);
        if (pct > lastPct) {
          lastPct = pct;
          onProgress({ percent: pct, received, total });
        }
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const digest = hash.digest('hex');
    if (expectedSha256 && digest !== String(expectedSha256).toLowerCase()) {
      throw new Error('SHA256 校验失败，请重试');
    }
    fs.renameSync(tmp, dest);
    return { bytes: received, sha256: digest };
  } catch (e) {
    try { out && out.destroy(); } catch { /* 已关闭 */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    if (controller.signal.aborted) {
      throw new Error(signal && signal.aborted ? '已取消下载' : '下载超时');
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 模型仓库的 SHA256SUMS：下载便携运行时时用于完整性校验（取不到就跳过，不阻塞安装）。
async function fetchRuntimeSha256(asset) {
  const text = await fetchText(PY_RUNTIME_BASE + '/' + PY_RUNTIME_TAG + '/SHA256SUMS', 20_000);
  if (!text) return '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.includes(asset)) continue;
    const m = /^([0-9a-fA-F]{64})\s/.exec(t);
    if (m) return m[1].toLowerCase();
  }
  return '';
}

// ---------- 多源下载 ----------

// GitHub 在国内经常连接超时：直连失败后依次尝试镜像。IC_PYTHON_RUNTIME_URL 可整体替换下载地址。
const GITHUB_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/', 'https://hk.gh-proxy.com/'];

function mirrorUrls(url, includeCustom = true) {
  const out = [];
  const custom = includeCustom ? String(process.env.IC_PYTHON_RUNTIME_URL || '').trim() : '';
  if (custom) out.push(custom);
  out.push(url);
  for (const prefix of GITHUB_MIRRORS) out.push(prefix + url);
  return [...new Set(out)];
}

async function downloadWithMirrors(url, dest, opts = {}) {
  let lastErr = null;
  for (const [i, candidate] of mirrorUrls(url).entries()) {
    try {
      if (i > 0 && typeof opts.report === 'function') opts.report({ detail: '直连失败，切换备用下载源…' });
      return await downloadToFile(candidate, dest, opts);
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      lastErr = e;
      logger.warn('下载源不可用，尝试下一个', { url: String(candidate).slice(0, 100), error: e && e.message });
    }
  }
  throw lastErr || new Error('下载失败');
}

async function fetchText(url, timeoutMs = 15_000) {
  for (const candidate of mirrorUrls(url, false)) {
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* 已结束 */ } }, timeoutMs);
    try {
      const res = await fetch(candidate, { redirect: 'follow', signal: ac.signal });
      if (!res.ok) continue;
      return await res.text();
    } catch { /* 换下一个源 */ } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

// ---------- 便携 Python 运行时 ----------

// 没装 Python 时自动下载一份 install_only 构建到 data/subtitle/python-runtime/，解压即用。
export async function ensurePortablePython({ report, signal } = {}) {
  const rp = typeof report === 'function' ? report : () => {};
  const p = subtitlePaths();
  const bin = bundledPythonPath();
  if (fs.existsSync(bin)) return { ok: true, path: bin, version: PY_RUNTIME_VERSION, source: 'bundled', error: '' };

  const asset = runtimeAssetName();
  if (!asset) {
    throw new Error('当前平台（' + process.platform + '/' + process.arch + '）不支持自动安装 Python，请手动安装 Python 3.9+ 并填写解释器路径');
  }
  const url = PY_RUNTIME_BASE + '/' + PY_RUNTIME_TAG + '/' + asset;

  fs.mkdirSync(p.root, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-py-'));
  const tarPath = path.join(tmpDir, asset);
  try {
    rp({ percent: 1, detail: '未检测到 Python，正在下载便携运行时（约 25MB）…' });
    const sum = await fetchRuntimeSha256(asset);
    const { bytes } = await downloadWithMirrors(url, tarPath, {
      signal,
      report: rp,
      expectedSha256: sum,
      timeoutMs: 10 * 60 * 1000,
      onProgress: ({ percent, received, total }) => rp({
        percent: Math.round(percent * 0.7),
        detail: '下载 Python 运行时 ' + Math.round(received / 1048576) + '/' + Math.round(total / 1048576) + ' MB',
      }),
    });
    rp({ percent: 72, detail: '解压 Python 运行时…' });
    const stage = p.runtimeDir + '.tmp';
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    await runCommand('tar', ['-xzf', tarPath, '-C', stage], { signal, timeoutMs: 5 * 60 * 1000 });
    fs.rmSync(p.runtimeDir, { recursive: true, force: true });
    fs.renameSync(stage, p.runtimeDir);
    if (!fs.existsSync(bin)) throw new Error('便携 Python 解压后未找到解释器：' + bin);
    clearPythonCache();
    rp({ percent: 80, detail: '便携 Python 已就绪（' + PY_RUNTIME_VERSION + '）' });
    logger.info('便携 Python 运行时安装完成', { bytes, path: bin });
    return { ok: true, path: bin, version: PY_RUNTIME_VERSION, source: 'bundled', error: '' };
  } catch (e) {
    fs.rmSync(path.join(p.runtimeDir + '.tmp'), { recursive: true, force: true });
    throw new Error('自动安装 Python 失败：' + (e && e.message ? e.message : String(e)) + '（也可以手动安装 Python 3.9+ 并在设置里填写解释器路径）');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ---------- 模型下载 ----------

async function downloadModel(name, { report, signal }) {
  const m = SUBTITLE_MODELS[name];
  const p = subtitlePaths();
  fs.mkdirSync(p.modelDir, { recursive: true });
  const dest = path.join(p.modelDir, m.file);
  // URL 倒数第二段就是 OpenAI 官方公布的 SHA256
  const expected = String(m.url).split('/').slice(-2)[0].toLowerCase();

  report({ percent: 0, detail: '连接模型服务器…' });
  let res;
  try {
    res = await downloadToFile(m.url, dest, {
      signal,
      expectedSha256: expected,
      onProgress: ({ percent, received, total }) => report({
        percent,
        detail: '下载中 ' + Math.round(received / 1048576) + '/' + Math.round(total / 1048576) + ' MB',
      }),
    });
  } catch (e) {
    throw new Error('模型下载失败：' + (e && e.message ? e.message : String(e)));
  }
  report({ percent: 100, detail: '模型已就绪' });
  logger.info('字幕模型下载完成', { model: name, bytes: res.bytes });
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

// ---------- 外部 audio2srt 服务 ----------
// 接口文档：<服务地址>/docs，实现参考 https://github.com/SwotAtmk/audio2srt_service
//   POST /api/v1/transcriptions            上传音频/视频，202 返回 task_id
//   GET  /api/v1/transcriptions/{id}       轮询状态（status/progress/error）
//   GET  /api/v1/transcriptions/{id}/srt   下载 SRT
//   GET  /health, /openapi.json            连通性与接口匹配检测

const A2S = {
  health: '/health',
  create: '/api/v1/transcriptions',
  task: (id) => '/api/v1/transcriptions/' + encodeURIComponent(id),
  srt: (id) => '/api/v1/transcriptions/' + encodeURIComponent(id) + '/srt',
};

async function fetchWithTimeout(url, { method = 'GET', body, signal, timeoutMs = 30_000 } = {}) {
  const ac = new AbortController();
  const onAbort = () => { try { ac.abort(); } catch { /* 已结束 */ } };
  if (signal) {
    if (signal.aborted) throw new Error('已停止');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { try { ac.abort(); } catch { /* 已结束 */ } }, timeoutMs);
  try {
    return await fetch(url, { method, body, redirect: 'follow', signal: ac.signal });
  } catch (e) {
    if (signal && signal.aborted) throw new Error('已停止：字幕服务请求已取消');
    if (ac.signal.aborted) throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）');
    const cause = e && e.cause && e.cause.message ? '（' + e.cause.message + '）' : '';
    throw new Error('无法连接字幕服务：' + (e && e.message ? e.message : String(e)) + cause);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const raw = (data && (data.error?.message || data.detail || data.message)) || text.slice(0, 200) || ('HTTP ' + res.status);
    throw new Error(typeof raw === 'string' ? raw : JSON.stringify(raw));
  }
  if (!data) throw new Error('字幕服务返回了非 JSON 内容');
  return data;
}

// 设置页「测试连接」：既测连通性，也判断对面是不是 audio2srt 的接口。
export async function testSubtitleApi(baseUrl) {
  const base = normalizeApiBase(baseUrl);
  if (!base) return { ok: false, compatible: false, error: '请填写服务地址' };

  let health = null;
  let openapi = null;
  let healthErr = '';
  try { health = await fetchJson(base + A2S.health, { timeoutMs: 8000 }); } catch (e) { healthErr = e.message; }
  // 部分部署会关掉 /docs，openapi.json 取不到不影响最终判定
  try { openapi = await fetchJson(base + '/openapi.json', { timeoutMs: 8000 }); } catch { /* 忽略 */ }

  if (!health && !openapi) {
    return { ok: false, compatible: false, error: healthErr || '无法连接服务，请确认已启动且地址正确' };
  }

  const paths = (openapi && openapi.paths) || {};
  const hasCreate = !!paths[A2S.create];
  const hasSrt = Object.keys(paths).some((p) => p.endsWith('/{task_id}/srt'));
  const looksLikeA2s = !!health && typeof health.service_version === 'string' && Array.isArray(health.downloaded_models);
  const compatible = (hasCreate && hasSrt) || looksLikeA2s;

  return {
    ok: true,
    compatible,
    title: (openapi && openapi.info && openapi.info.title) || 'audio2srt API',
    apiVersion: (openapi && openapi.info && openapi.info.version) || '',
    serviceVersion: (health && health.service_version) || (openapi && openapi.info && openapi.info.version) || '',
    models: health && Array.isArray(health.downloaded_models) ? health.downloaded_models : [],
    loadedModels: health && Array.isArray(health.loaded_models) ? health.loaded_models : [],
    ffmpegOk: !!(health && health.ffmpeg && health.ffmpeg.ok),
    queueWorkers: health && health.queue_workers != null ? health.queue_workers : null,
    error: compatible ? '' : '接口不匹配：未发现 /api/v1/transcriptions 与 SRT 下载接口',
  };
}

// api 模式：抽音轨 → 上传 → 轮询 → 拿 SRT。
async function transcribeViaApi({ inputs, cfg, onProgress, isAborted }) {
  const report = (d) => { if (d && onProgress) onProgress(String(d)); };
  const base = cfg.apiBaseUrl;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-asr-api-'));
  const wav = path.join(tmpDir, 'audio.wav');
  // 任务停止：把正在飞的 HTTP 请求一起打断，而不是等上传/轮询自己结束。
  const ac = new AbortController();
  const aborter = setInterval(() => {
    if (isAborted && isAborted()) { try { ac.abort(); } catch { /* 已结束 */ } }
  }, 800);
  try {
    report('提取音轨…');
    await extractConcatAudio(inputs, wav, { isAborted });

    // 视频章节的 WAV 可能有上百 MB：优先用 Blob 流式上传，避免整段读进内存。
    const openAsBlob = fs.openAsBlob || (fs.promises && fs.promises.openAsBlob);
    const blob = openAsBlob
      ? await openAsBlob.call(fs, wav, { type: 'audio/wav' })
      : new Blob([fs.readFileSync(wav)], { type: 'audio/wav' });
    const form = new FormData();
    form.append('file', blob, 'audio.wav');
    if (cfg.model) form.append('model', cfg.model);
    if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language);

    report('上传音轨到 audio2srt 服务…');
    const created = await fetchJson(base + A2S.create, { method: 'POST', body: form, signal: ac.signal, timeoutMs: 10 * 60 * 1000 });
    const taskId = String(created.task_id || '');
    if (!taskId) throw new Error('字幕服务未返回 task_id');
    report('已提交转写任务：' + taskId);

    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    let task = created;
    let lastPct = -1;
    while (task.status !== 'completed') {
      if (isAborted && isAborted()) throw new Error('已停止：语音识别已终止');
      if (Date.now() > deadline) throw new Error('audio2srt 转写超时（2 小时）');
      if (task.status === 'failed') {
        const msg = task.error && task.error.message ? task.error.message : '转写失败';
        throw new Error('audio2srt 转写失败：' + msg);
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      task = await fetchJson(base + A2S.task(taskId), { signal: ac.signal, timeoutMs: 30_000 });
      const pct = Number(task.progress);
      if (Number.isFinite(pct) && pct !== lastPct) {
        lastPct = pct;
        report('识别中 ' + pct + '%');
      }
    }

    report('下载字幕文件…');
    const res = await fetchWithTimeout(base + A2S.srt(taskId), { signal: ac.signal, timeoutMs: 60_000 });
    if (!res.ok) throw new Error('下载 SRT 失败 HTTP ' + res.status);
    const srt = await res.text();
    if (!String(srt).trim()) throw new Error('字幕服务返回了空 SRT');
    return {
      srt,
      cues: Number(task.segment_count) || 0,
      model: String(task.model || cfg.model),
      language: String(task.detected_language || cfg.language || 'auto'),
    };
  } finally {
    clearInterval(aborter);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
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
//   whisper → 本地语音识别；环境/模型/识别失败时自动回退剧本台词，不阻断导出
//   api     → 外部 audio2srt 服务；连不上/转写失败同样回退剧本台词
export async function resolveSubtitles({ projectId, inputs, shots, onProgress, isAborted } = {}) {
  const cfg = resolveSubtitleConfig();
  if (cfg.mode === 'script') {
    return { srt: buildSrt(shots || []), cues: 0, model: '', language: cfg.language, mode: 'script', fallback: false };
  }
  try {
    const r = cfg.mode === 'api'
      ? await transcribeViaApi({ inputs, cfg, onProgress, isAborted })
      : await buildSubtitles({ projectId, inputs, onProgress, isAborted });
    return { ...r, mode: cfg.mode, fallback: false };
  } catch (e) {
    if (isAborted && isAborted()) throw e;
    const msg = e && e.message ? e.message : String(e);
    if (onProgress) {
      onProgress((cfg.mode === 'api' ? '字幕服务不可用' : '语音识别不可用') + '，回退剧本字幕：' + msg);
    }
    return { srt: buildSrt(shots || []), cues: 0, model: cfg.model, language: cfg.language, mode: cfg.mode, fallback: true, error: msg };
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
    apiBaseUrl: cfg.apiBaseUrl,
    languages: SUBTITLE_LANGUAGES,
    python: detectPython(cfg.pythonPath),
    env: envStatus(),
    models,
    tasks: subtitleTasks(),
  };
}
