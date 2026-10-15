import fs from 'node:fs';
import { sleep } from './utils.js';

// —— 云端视频 API 后端（文生视频 / 图生视频）——
// 与 comfyui.js / runninghub.js 并列的「视频渲染后端」，但走的是云端厂商的
// OpenAI-Videos 兼容（或厂商自有）接口，而非本地 ComfyUI 图 / RunningHub 工作流。
//
// 调用方：lib/agent/tools.js 的 generateShotVideo 按 cfg.generation.videoProvider 选择后端：
//   'comfyui'（默认，含 native / runninghub）→ 走原 ComfyUI 链路，本模块不参与；
//   'agnes'                              → 走下方 agnesGenerate（Agnes Video 2.5 Flash）。
//
// 当前仅实现 Agnes；后续可加 Seedance / Kling 等，统一从 generateVideoViaApi 分派。
// 适配器返回的 { url, video_id } 由调用方直接下载落盘，存储方式与 ComfyUI 产物保持一致。

const AGNES_DEFAULT_BASE = 'https://apihub.agnes-ai.com/v1';

function agnesCfg(cfg) {
  const a = cfg?.generation?.agnes || {};
  return {
    baseUrl: String(a.baseUrl || AGNES_DEFAULT_BASE).replace(/\/+$/, ''),
    apiKey: a.apiKey || process.env.AGNES_API_KEY || '',
  };
}

function agnesKey(cfg) {
  return String(agnesCfg(cfg).apiKey || '').trim();
}

// 把含 /v1 的 base 还原成 host：Agnes 的查询接口在 /agnesapi，不在 /v1 下
function agnesHost(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, '');
}

async function agnesPost(cfg, subPath, body, { timeoutMs = 60_000 } = {}) {
  const { baseUrl } = agnesCfg(cfg);
  const res = await fetch(baseUrl + subPath, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + agnesKey(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.detail || j?.error?.message || detail;
    } catch {}
    throw new Error('Agnes 请求失败 ' + res.status + '：' + detail);
  }
  return JSON.parse(text);
}

// request: { prompt, mode='text', seconds=5, aspect_ratio='16:9', seed?, images?, audios?, first_frame?, last_frame? }
// 返回 { url, video_id, task_id }
export async function agnesGenerate(cfg, request, opts = {}) {
  const key = agnesKey(cfg);
  if (!key) throw new Error('未配置 Agnes API Key（generation.agnes.apiKey 或环境变量 AGNES_API_KEY）');

  const body = {
    model: 'agnes-video-2.5-flash',
    prompt: request.prompt,
    mode: request.mode || 'text',
    seconds: String(request.seconds ?? 5),
    size: '720P', // Flash 仅支持 720P
    aspect_ratio: request.aspect_ratio || '16:9',
    n: 1,
  };
  if (request.seed != null) body.seed = request.seed;
  if (body.mode === 'keyframe') {
    if (request.first_frame) body.first_frame = request.first_frame;
    if (request.last_frame) body.last_frame = request.last_frame;
  } else if (body.mode === 'reference') {
    if (Array.isArray(request.images) && request.images.length) body.images = request.images.slice(0, 5);
    if (Array.isArray(request.audios) && request.audios.length) body.audios = request.audios.slice(0, 3);
  }

  if (opts.onStatus) opts.onStatus({ kind: 'queued' });
  const created = await agnesPost(cfg, '/videos', body, { timeoutMs: 60_000 });
  const videoId = created.video_id || created.id || created.task_id;
  if (!videoId) throw new Error('Agnes 创建任务未返回 video_id：' + JSON.stringify(created).slice(0, 200));
  if (opts.onSubmitted) opts.onSubmitted(videoId);

  const host = agnesHost(agnesCfg(cfg).baseUrl);
  const queryUrl =
    host + '/agnesapi?video_id=' + encodeURIComponent(videoId) + '&model_name=agnes-video-2.5-flash';
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.isAborted && opts.isAborted()) throw new Error('任务已停止');
    const res = await fetch(queryUrl, {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error('Agnes 查询失败 ' + res.status + '：' + (await res.text()).slice(0, 200));
    const j = await res.json().catch(() => ({}));
    const status = j.status || j.video_status;
    if (status === 'completed') {
      const url = j.url || j.metadata?.url || j.video_url || j.data?.url;
      if (!url) throw new Error('Agnes 任务完成但未返回视频地址：' + JSON.stringify(j).slice(0, 200));
      return { url, video_id: videoId, task_id: j.id || videoId };
    }
    if (status === 'failed') throw new Error('Agnes 任务失败：' + (j.error?.message || j.error || '未知错误'));
    if (opts.onStatus) opts.onStatus({ kind: 'progress', progress: j.progress || 0 });
    await sleep(pollMs);
  }
  throw new Error('Agnes 生成超时（' + Math.round(timeoutMs / 60000) + ' 分钟），video_id=' + videoId);
}

// 统一入口：按 cfg.generation.videoProvider 分派（默认 comfyui 时由调用方拦截，不会进这里）
export async function generateVideoViaApi(cfg, request, opts = {}) {
  const provider = String(cfg?.generation?.videoProvider || 'agnes').toLowerCase();
  if (provider === 'agnes') return agnesGenerate(cfg, request, opts);
  // 未来扩展：seedance / kling ...
  throw new Error('不支持的视频 API 提供商：' + provider + '（当前仅支持 agnes）');
}
