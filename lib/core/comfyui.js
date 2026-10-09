import fs from 'node:fs';
import { normBaseUrl, sleep } from './utils.js';
import { logger } from './logger.js';

// —— ComfyUI HTTP 调用超时兜底 ——
// 背景：ComfyUI 进程可能「假死」——TCP 连接还挂着，但前端永不响应。此时无超时的 fetch
// 会永远 pending，generate() 的 deadline 兜底就卡死在 await getHistory() 里，分钟级
// 超时形同虚设 → 任务永不结束 → project.status 永远是 running → 前端「停止」按钮常亮。
// 所以这里所有 fetch 统一挂 AbortSignal.timeout：端点假死时 fetch 会按时抛错，
// getHistory/getQueue 吞错继续轮询直到 deadline，queuePrompt/downloadOutput/freeComfy
// 则直接抛给上层收尾成 failed，保证生成任务必然在有界时间内结束。
const HTTP_TIMEOUT = {
  poll: 15_000,          // /history /queue 轮询：本地回环正常 <50ms，15s 只可能是假死
  queue: 30_000,         // 提交工作流 /prompt（工作流可能有大量文本节点）
  upload: 60_000,        // 上传参考图/音频
  download: 5 * 60_000,  // 下载产物视频/音频（可达数百 MB）
  free: 30_000,          // /free 释放显存
  objectInfo: 30_000,    // /object_info
};

export async function uploadToInput(baseUrl, localPath, filename) {
  const buf = fs.readFileSync(localPath);
  logger.debug('上传文件到 ComfyUI input', { filename, bytes: buf.length });
  const form = new FormData();
  form.append('image', new Blob([buf]), filename);
  form.append('overwrite', 'true');
  const res = await fetch(normBaseUrl(baseUrl) + '/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(HTTP_TIMEOUT.upload) });
  if (!res.ok) throw new Error('上传到 ComfyUI 失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

export async function queuePrompt(baseUrl, workflow, clientId) {
  logger.debug('ComfyUI 提交工作流', { nodes: Object.keys(workflow).length });
  const res = await fetch(normBaseUrl(baseUrl) + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT.queue),
  });
  if (!res.ok) throw new Error('提交工作流失败 ' + res.status + ': ' + (await res.text()).slice(0, 500));
  const body = await res.json();
  if (body?.error) {
    throw new Error('ComfyUI 校验失败: ' + JSON.stringify(body.error).slice(0, 800) + (body?.node_errors ? ' ' + JSON.stringify(body.node_errors).slice(0, 500) : ''));
  }
  return body;
}

export async function getHistory(baseUrl, promptId) {
  try {
    const res = await fetch(normBaseUrl(baseUrl) + '/history/' + promptId, { signal: AbortSignal.timeout(HTTP_TIMEOUT.poll) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function getQueue(baseUrl) {
  try {
    const res = await fetch(normBaseUrl(baseUrl) + '/queue', { signal: AbortSignal.timeout(HTTP_TIMEOUT.poll) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function getPromptStatus(baseUrl, promptId) {
  if (!promptId) return { status: 'not_found' };
  const h = await getHistory(baseUrl, promptId);
  if (h && h[promptId]) {
    const entry = h[promptId];
    if (entry.status?.status_str === 'error') return { status: 'error', entry };
    return { status: 'done', entry, outputs: collectOutputs(entry.outputs) };
  }
  const q = await getQueue(baseUrl);
  const inQueue = (q?.queue_running || []).concat(q?.queue_pending || []).some((it) => it?.[1] === promptId);
  if (inQueue) return { status: 'running' };
  return { status: 'not_found' };
}

const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|m4v|gif)$/i;

// 从 history.outputs 收集产物，正确区分图片/视频/音频（视频节点可能挂在 images 键下）
export function collectOutputs(outputs) {
  const result = [];
  for (const nodeOut of Object.values(outputs || {})) {
    const animated = Array.isArray(nodeOut?.animated) ? nodeOut.animated : [];
    for (const kind of ['images', 'gifs', 'videos', 'audio']) {
      const arr = nodeOut?.[kind] || [];
      arr.forEach((item, i) => {
        const name = item?.filename || '';
        let outKind = kind;
        if (kind === 'gifs') outKind = 'videos';
        if (kind === 'images' && (animated[i] === true || VIDEO_EXT.test(name))) outKind = 'videos';
        result.push({ ...item, kind: outKind });
      });
    }
  }
  return result;
}

// 提交并等待完成
// isAborted：调用方传入的停止标记函数；轮询期间一旦返回 true，立即中断 ComfyUI
// 当前执行的任务并抛错，让「停止任务」能在单个视频/图片生成中途生效，而不是
// 空等到该次生成跑完或超时（视频单镜可达数分钟、超时上限 90 分钟）。
export async function generate(baseUrl, workflow, { timeoutMs = 30 * 60 * 1000, pollMs = 1500, onStatus, onSubmitted, isAborted } = {}) {
  const clientId = crypto.randomUUID();
  let ws = null;
  try {
    ws = new WebSocket(normBaseUrl(baseUrl).replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'progress' && onStatus) onStatus({ kind: 'progress', value: m.data?.value, max: m.data?.max, node: m.data?.node });
        else if (m.type === 'execution_error' && onStatus) onStatus({ kind: 'error', message: m.data?.exception_message || '执行出错' });
      } catch {}
    };
  } catch {}

  const { prompt_id } = await queuePrompt(baseUrl, workflow, clientId);
  if (onSubmitted) onSubmitted(prompt_id);
  if (onStatus) onStatus({ kind: 'queued', prompt_id });

  const finish = (entry) => {
    const outputs = collectOutputs(entry.outputs);
    try { ws?.close(); } catch {}
    return { prompt_id, outputs, entry };
  };
  const abort = async () => {
    try { ws?.close(); } catch {}
    // 真正打断 ComfyUI 正在跑的这张图，避免用户已停止还在烧 GPU/占队列
    try { await interrupt(baseUrl); } catch {}
    throw new Error('任务已停止');
  };
  if (isAborted && isAborted()) await abort();

  const deadline = Date.now() + timeoutMs;
  // 主动查询任务状态（不能只靠分钟级超时兜底）：
  //   每轮并行查 /history + /queue —— 任务还在队列里就正常等待；
  //   既不在队列又无产出记录（ComfyUI 被重启/清队/执行中断未写回）时主动判失败，
  //   连续 MISSING_CONFIRM 次确认才抛错，缓冲 history/queue 迁移的瞬时窗口。
  let missingStreak = 0;
  const MISSING_CONFIRM = 3;
  while (Date.now() < deadline) {
    if (isAborted && isAborted()) await abort();
    const [h, q] = await Promise.all([getHistory(baseUrl, prompt_id), getQueue(baseUrl)]);
    if (h && h[prompt_id]) {
      const entry = h[prompt_id];
      if (entry.status?.status_str === 'error') {
        const msgs = entry.status?.messages || [];
        // 被中断（用户在 ComfyUI 后台手动 interrupt / 服务中断）会以 error 状态写回 history，
        // 且 messages 里带 execution_interrupted。这种要单独标记，不能和「执行失败」混为一谈，
        // 否则上层会把中断当失败，继续生成下一个分镜。
        const interrupted = msgs.some((m) => Array.isArray(m) && m[0] === 'execution_interrupted');
        const err = new Error(interrupted
          ? 'ComfyUI 任务被中断'
          : 'ComfyUI 执行出错: ' + JSON.stringify(msgs).slice(0, 1000));
        err.interrupted = interrupted;
        throw err;
      }
      missingStreak = 0;
      return finish(entry);
    }
    if (!q) {
      // /queue 也查不到（端点假死/重启中）：不计数，由 fetch 超时 + deadline 兜底
    } else {
      const stillQueued = (q.queue_running || []).concat(q.queue_pending || []).some((it) => it?.[1] === prompt_id);
      if (stillQueued) missingStreak = 0;
      else if (++missingStreak >= MISSING_CONFIRM) {
        try { ws?.close(); } catch {}
        throw new Error('ComfyUI 任务丢失：prompt_id=' + prompt_id + ' 已不在执行/等待队列，也没有产出记录。疑似 ComfyUI 被重启或队列被清空，任务已主动放弃（不等待超时）。');
      }
    }
    await sleep(pollMs);
  }
  // 复查一次：可能刚好在最后一次轮询与超时判定之间完成，误判会丢掉已生成的产物
  const last = await getHistory(baseUrl, prompt_id);
  if (last && last[prompt_id] && last[prompt_id].status?.status_str !== 'error') {
    logger.warn('ComfyUI 在超时临界点完成，按成功返回', { prompt_id });
    return finish(last[prompt_id]);
  }
  try { ws?.close(); } catch {}
  throw new Error('ComfyUI 生成超时（' + Math.round(timeoutMs / 60000) + ' 分钟），prompt_id=' + prompt_id);
}

// 调用 ComfyUI /interrupt：中断当前正在执行的任务（队列里的当前 prompt）。
export async function interrupt(baseUrl) {
  const res = await fetch(normBaseUrl(baseUrl) + '/interrupt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT.queue),
  });
  if (!res.ok) throw new Error('ComfyUI /interrupt 失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

// 调用 ComfyUI /free：卸载全部模型 + 清空显存缓存。
// 注意该端点只设置队列 flag，实际清理发生在「下一个任务执行完成后」（main.py 执行循环消费）。
// 用途：连续生成多个视频后释放 dynamic-vram 累积的显存状态，防止速度逐步退化。
export async function freeComfy(baseUrl) {
  const res = await fetch(normBaseUrl(baseUrl) + '/free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT.free),
  });
  if (!res.ok) throw new Error('ComfyUI /free 失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

export async function downloadOutput(baseUrl, out) {
  const url = new URL('/view', normBaseUrl(baseUrl));
  url.searchParams.set('filename', out.filename);
  url.searchParams.set('subfolder', out.subfolder || '');
  url.searchParams.set('type', out.type || 'output');
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT.download) });
  if (!res.ok) throw new Error('下载输出失败 ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

export async function checkComfyUI(baseUrl) {
  try {
    const res = await fetch(normBaseUrl(baseUrl) + '/system_stats', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('status ' + res.status);
    const j = await res.json();
    const argv = j.system?.argv || [];
    return {
      ok: true,
      system: j.system?.comfyui_version || 'unknown',
      device: j.devices?.[0]?.name || '',
      // 阶段调度要用：CK 注意力开关、comfy-kitchen 版本（判定 CK 回归是否命中）、显存余量
      ckAttention: argv.includes('--use-ck-attention'),
      ckKitchen: (j.system?.comfy_package_versions || []).find((p) => p.name === 'comfy-kitchen')?.installed || '',
      vramFree: j.devices?.[0]?.vram_free || 0,
      // Dynamic VRAM 默认开启，--disable-dynamic-vram 关闭（独立生图实例会关）
      dynamicVram: !argv.includes('--disable-dynamic-vram'),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getObjectInfo(baseUrl) {
  const res = await fetch(normBaseUrl(baseUrl) + '/object_info', { signal: AbortSignal.timeout(HTTP_TIMEOUT.objectInfo) });
  if (!res.ok) throw new Error('读取 object_info 失败 ' + res.status);
  return res.json();
}
