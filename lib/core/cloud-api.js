import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sleep } from './utils.js';
import { logger } from './logger.js';

// —— 云端 API 适配层（OpenAI 兼容中转生图 + 视频/配音分派）——
// 纯 fetch 实现，无三方依赖；本文件只管 OpenAI 兼容 t2i/i2i 与共享工具，
// r2v/tts 分派给 cloud-video.js / cloud-tts.js（同事并行维护）。

// 通用 JSON 请求：非 2xx 抛错，错误信息带 status + 响应体前 300 字（便于排查厂商报错）
export async function httpJson(url, init = {}, timeoutMs = 30_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('云端 API 请求失败 ' + res.status + ': ' + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('云端 API 返回非 JSON：' + text.slice(0, 300));
  }
}

// 下载二进制文件（产物 / 参考图），返回 Buffer。
// headers 可选：有些厂商的取件接口（如视频 /content）要带鉴权头，公开直链则不需要。
export async function httpGetBuffer(url, timeoutMs = 300_000, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(headers ? { headers } : {}) });
  if (!res.ok) {
    const err = new Error('下载文件失败 ' + res.status + ': ' + url);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

// 读本地媒体为 base64 / dataUri（云端 API 多以 base64 直传，不做上传）
export function readMediaBase64(absPath) {
  if (!fs.existsSync(absPath)) throw new Error('媒体文件不存在：' + absPath);
  const buf = fs.readFileSync(absPath);
  const mime = MIME_BY_EXT[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const base64 = buf.toString('base64');
  return { base64, dataUri: 'data:' + mime + ';base64,' + base64, mime, bytes: buf.length };
}

// 指数退避重试 1s/2s/4s；401/403 鉴权失败重试无意义，直接抛
export async function withRetry(fn, { times = 3, onRetry } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) throw e;
      if (i >= times - 1) throw e;
      if (onRetry) {
        try { onRetry(e, i + 1); } catch {}
      }
      await sleep(1000 * 2 ** i);
    }
  }
}

// 用户主动停止：带 interrupted 标记，调用方据此区分「中止」与「失败」
export function abortedError(message = '任务已停止') {
  const err = new Error(message);
  err.interrupted = true;
  return err;
}

// 产物项统一结构，下游 collectOutputs / pickOutput 按 kind 认产物
export function outItem({ filename, kind, fileUrl }) {
  return { filename, subfolder: '', type: 'output', kind, fileUrl };
}

// 把 Buffer 落到系统临时目录，返回 file:// URL（b64 图像 / 配音等无远程 URL 的产物）
export function saveTempMedia(buf, ext) {
  const name = 'ic_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + (ext || '');
  const abs = path.join(os.tmpdir(), name);
  fs.writeFileSync(abs, buf);
  return pathToFileURL(abs).href;
}

// 容错取值：响应结构不确定时，按给定路径顺序找第一个非空值（点号分隔，数字段当数组下标）
export function tolerantPick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    let hit = true;
    for (const seg of String(p).split('.')) {
      if (cur == null) { hit = false; break; }
      cur = cur[seg];
    }
    if (hit && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

// —— OpenAI 兼容图像接口（gpt-image 系列）——

// baseUrl / model 一律从 cfg.mediaApi.image 读，不硬编码
function imageBase(cfg) {
  const baseUrl = String(cfg?.mediaApi?.image?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('缺少图像 baseUrl（mediaApi.image.baseUrl）');
  const model = String(cfg?.mediaApi?.image?.model || '').trim();
  if (!model) throw new Error('缺少图像 model（mediaApi.image.model）');
  return { baseUrl, model };
}

// 统一鉴权：Authorization: Bearer <apiKey>
function imageAuth(cfg) {
  const apiKey = String(cfg?.mediaApi?.image?.apiKey || '').trim();
  if (!apiKey) throw new Error('缺少图像密钥（mediaApi.image.apiKey）');
  return 'Bearer ' + apiKey;
}

// gpt-image 只认固定档位：按 width/height 比值就近匹配（纯函数便于测试）
const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
// 中转站是同步出图：1024 方图约 40 秒，1536x1024 的人物三视图要三五分钟，
// 卡在 120 秒会「超时→重试→又超时」，白等还白烧钱。
const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
export function sizeForImageApi(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return '1024x1024';
  const target = w / h;
  let best = '1024x1024';
  let bestDiff = Infinity;
  for (const s of IMAGE_SIZES) {
    const [a, b] = s.split('x').map(Number);
    const diff = Math.abs(target - a / b);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// 中转站返回结构不定：按优先级依次找图像，b64_json 落临时文件转 file://，url 直接用
function resolveImageFileUrl(json) {
  const steps = [
    ['b64', 'data.0.b64_json'],
    ['url', 'data.0.url'],
    ['b64', 'data.image.b64_json'],
    ['url', 'data.image.url'],
    ['url', 'images.0.url'],
    ['url', 'output.0.url'],
  ];
  for (const [kind, p] of steps) {
    const v = tolerantPick(json, [p]);
    if (!v) continue;
    if (kind === 'b64') return saveTempMedia(Buffer.from(String(v), 'base64'), '.png');
    return String(v);
  }
  return '';
}

// prompt_id：拿不到就本地兜底，保证下游有稳定标识
function pickPromptId(json, fallbackId) {
  const id = tolerantPick(json, ['id', 'data.0.id', 'created']);
  if (id) return String(id);
  return fallbackId ? String(fallbackId) : 'img_' + Date.now();
}

// 响应 → 产物结构（filename = prompt_id + '.png'，kind = 'images'）
function imageOutputs(json, fallbackId) {
  const fileUrl = resolveImageFileUrl(json);
  if (!fileUrl) throw new Error('图像 API 未返回可解析的图片：' + JSON.stringify(json).slice(0, 300));
  const id = pickPromptId(json, fallbackId);
  return { prompt_id: id, outputs: [outItem({ filename: id + '.png', kind: 'images', fileUrl })] };
}

// 少数中转站图像也异步：状态排队/进行中且有 task id 时才轮询，同步返回根本走不到
const IMAGE_PENDING = new Set(['queued', 'in_progress', 'processing']);

async function imagePoll(cfg, taskId, opts) {
  const { baseUrl } = imageBase(cfg);
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = opts.pollMs ?? 3000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.isAborted?.()) throw abortedError();
    const j = await httpJson(baseUrl + '/images/generations/' + encodeURIComponent(taskId), {
      headers: { Authorization: imageAuth(cfg) },
    }, 30_000);
    const st = String(tolerantPick(j, ['data.0.status', 'status']) || '').toLowerCase();
    if (!IMAGE_PENDING.has(st)) {
      if (st === 'failed' || st === 'error') {
        throw new Error('图像任务失败：' + JSON.stringify(j).slice(0, 300));
      }
      return imageOutputs(j, taskId);
    }
    await sleep(pollMs);
  }
  throw new Error('图像生成超时（' + Math.round(timeoutMs / 60000) + ' 分钟），taskId=' + taskId);
}

// —— 图像任务提交与分派 ——

// 提交后统一处理：上报 onSubmitted/queued，异步则轮询，同步则直接解析
async function afterSubmit(json, cfg, opts) {
  const promptId = pickPromptId(json);
  if (opts.onSubmitted) opts.onSubmitted(promptId);
  if (opts.onStatus) opts.onStatus({ kind: 'queued', prompt_id: promptId });
  if (opts.isAborted?.()) throw abortedError();

  const st = String(tolerantPick(json, ['data.0.status', 'status']) || '').toLowerCase();
  const taskId = tolerantPick(json, ['id', 'data.0.id', 'task_id', 'data.0.task_id']);
  if (IMAGE_PENDING.has(st) && taskId) return await imagePoll(cfg, String(taskId), opts);
  return imageOutputs(json, promptId);
}

// generations（JSON body），带重试
async function postGenerations(cfg, body) {
  const { baseUrl } = imageBase(cfg);
  return await withRetry(
    () => httpJson(baseUrl + '/images/generations', {
      method: 'POST',
      headers: { Authorization: imageAuth(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, IMAGE_REQUEST_TIMEOUT_MS),
    { onRetry: (e, n) => logger.warn('图像 API 请求失败，重试 ' + n, { error: e.message }) },
  );
}

// 文生图：POST /images/generations
async function openaiT2i(cfg, params, opts) {
  const { model } = imageBase(cfg);
  const json = await postGenerations(cfg, {
    model,
    prompt: String(params.positive_prompt || ''),
    n: 1,
    size: sizeForImageApi(params.width, params.height),
  });
  return await afterSubmit(json, cfg, opts);
}

// edits 是否「不被支持」：404/405 或错误体含 invalid_request_error/model_not_found；401/403 不算，直接抛
function isEditsUnsupported(err) {
  if (err?.status === 404 || err?.status === 405) return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('invalid_request_error') || msg.includes('model_not_found');
}

// 图生图：优先 multipart /images/edits，接口不认时退回 generations + data URI 参考图
async function openaiI2i(cfg, params, opts) {
  const { baseUrl, model } = imageBase(cfg);
  if (!params.image) throw new Error('图生图缺少参考图（params.image 本地绝对路径）');
  const size = sizeForImageApi(params.width, params.height);
  const prompt = String(params.positive_prompt || '');

  // edits 单次尝试（不套 withRetry）：不支持时尽快退回，避免 404/405 被反复重试拖慢
  try {
    const buf = fs.readFileSync(params.image);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', size);
    form.append('image', new Blob([buf]), path.basename(params.image));
    const json = await httpJson(baseUrl + '/images/edits', {
      method: 'POST',
      headers: { Authorization: imageAuth(cfg) },
      body: form,
    }, IMAGE_REQUEST_TIMEOUT_MS);
    return await afterSubmit(json, cfg, opts);
  } catch (e) {
    if (!isEditsUnsupported(e)) throw e; // 鉴权或其他错误退回也没用，直接抛
    logger.warn('图像 /images/edits 不被支持，退回 /images/generations（data URI 参考图）', { error: e.message });
  }

  const dataUri = readMediaBase64(params.image).dataUri;
  const json = await postGenerations(cfg, { model, prompt, n: 1, size, image: dataUri });
  return await afterSubmit(json, cfg, opts);
}

function openaiImageGenerate(cfg, spec, params, opts) {
  return spec.kind === 'i2i' ? openaiI2i(cfg, params, opts) : openaiT2i(cfg, params, opts);
}

// —— 对外契约（backend.js / workflow-runner.js 依赖，签名勿动）——

export function isCloudApi(cfg) {
  return cfg?.comfyui?.provider === 'api';
}

// 按 spec.kind 分派：t2i/i2i 走本文件 OpenAI 图像，r2v/tts 动态 import 同事的适配器
export async function cloudGenerate(cfg, spec, params, opts = {}) {
  const kind = spec?.kind;
  try {
    if (kind === 't2i' || kind === 'i2i') return await openaiImageGenerate(cfg, spec, params, opts);
    if (kind === 'r2v') {
      const m = await import('./cloud-video.js');
      return await m.openaiGenerateVideo(cfg, params, opts);
    }
    if (kind === 'tts') {
      const m = await import('./cloud-tts.js');
      return await m.mimoGenerateTts(cfg, params, opts);
    }
    throw new Error('不支持的云端任务类型：' + kind);
  } catch (e) {
    // 失败先上报状态再抛；用户主动中止（interrupted）不算失败
    if (!e?.interrupted && opts?.onStatus) {
      try { opts.onStatus({ kind: 'error', message: e.message }); } catch {}
    }
    throw e;
  }
}

// 下载产物；云端出错时常返回 json/xml/text 而不是文件，需校验。
// file:// 是本地落盘的产物（b64 图像 / 配音，无远程 URL 可取）
export async function cloudDownload(fileUrl) {
  const buf = String(fileUrl || '').startsWith('file:')
    ? await fs.promises.readFile(fileURLToPath(fileUrl))
    : await httpGetBuffer(fileUrl);
  const head = buf.toString('utf8', 0, Math.min(buf.length, 64)).trim();
  if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) {
    throw new Error('下载输出失败（返回了非文件内容）：' + buf.toString('utf8').slice(0, 300));
  }
  return buf;
}

// api 模式不上传：返回本地绝对路径，供适配器直接读文件
export function cloudLocalRef(localPath) {
  return localPath;
}

// —— 模型清单（设置页「拉取模型」与「测试连接」共用）——
// 中转站按 Key 分组返回清单：生图那把 Key 只回生图模型，视频那把只回视频模型，
// 所以每档各拉各的，天然就是能用的那几个，不用再做名字过滤。

const MODEL_SOURCES = {
  image: (cfg) => cfg?.mediaApi?.image,
  video: (cfg) => cfg?.mediaApi?.video,
  tts: (cfg) => cfg?.mediaApi?.tts,
  llm: (cfg) => cfg?.llm,
};

export function modelSource(cfg, group) {
  const pick = MODEL_SOURCES[group];
  if (!pick) throw new Error('未知的模型档位：' + group);
  const src = pick(cfg) || {};
  return {
    baseUrl: String(src.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(src.apiKey || '').trim(),
  };
}

// 把厂商报错翻成大白话：设置页直接显示这句话
function readableModelError(e) {
  const s = Number(e?.status);
  if (s === 401 || s === 403) return 'Key 不对或被拒（HTTP ' + s + '）';
  if (s === 404) return '这个网址没有 /models 接口，不支持自动列模型';
  if (e?.name === 'TimeoutError' || /abort/i.test(String(e?.message))) return '连不上或超时，检查一下网址';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(e?.message))) return '连不上这个网址';
  return String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160);
}

// baseUrl / apiKey 可显式传入：设置页要用「还没保存」的输入框现值去试
export async function listModels(cfg, group, { baseUrl, apiKey, timeoutMs = 15_000 } = {}) {
  const src = modelSource(cfg, group);
  const base = String(baseUrl ?? src.baseUrl).trim().replace(/\/+$/, '');
  const key = String(apiKey ?? src.apiKey).trim();
  if (!base) throw new Error('还没填 Base URL');
  if (!key) throw new Error('还没填 API Key');
  let json;
  try {
    json = await httpJson(base + '/models', { headers: { Authorization: 'Bearer ' + key } }, timeoutMs);
  } catch (e) {
    throw new Error(readableModelError(e));
  }
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list.map((m) => String(m?.id || m?.name || m || '').trim()).filter(Boolean);
}

// api 模式：真去各档网关拉一次模型清单，拉到了才算连上。
// 只查密钥配没配会让「测试连接」在 Key 填错时也报成功，等于没测。
export async function cloudCheck(cfg) {
  const groups = [
    { id: 'image', label: '生图' },
    { id: 'video', label: '视频' },
    { id: 'tts', label: '配音' },
  ];
  const rows = [];
  for (const g of groups) {
    const { baseUrl, apiKey } = modelSource(cfg, g.id);
    if (!baseUrl || !apiKey) { rows.push({ ...g, state: 'skip', text: '未填写' }); continue; }
    try {
      const models = await listModels(cfg, g.id);
      rows.push({ ...g, state: 'ok', text: models.length + ' 个模型', count: models.length });
    } catch (e) {
      rows.push({ ...g, state: 'fail', text: e.message });
    }
  }
  const filled = rows.filter((r) => r.state !== 'skip');
  const failed = filled.filter((r) => r.state === 'fail');
  if (!filled.length) return { ok: false, error: '三段都没填 Base URL / API Key，先填再测', groups: rows };
  const summary = rows.map((r) => r.label + '：' + r.text).join('；');
  if (failed.length) return { ok: false, error: '有 ' + failed.length + ' 段连不上 —— ' + summary, groups: rows };
  return {
    ok: true,
    system: '云端 API（OpenAI 兼容中转 + 小米 MiMo）',
    device: summary,
    groups: rows,
    ckAttention: false, ckKitchen: '', vramFree: 0, dynamicVram: false,
  };
}

// OpenAI 兼容中转无可靠取消接口：no-op，实际取消靠轮询里的 opts.isAborted() 退出
export async function cloudCancel(cfg, taskId) {}
