import fs from 'node:fs';
import { normBaseUrl, sleep } from './utils.js';
import { logger } from './logger.js';

export async function uploadToInput(baseUrl, localPath, filename) {
  const buf = fs.readFileSync(localPath);
  logger.debug('上传文件到 ComfyUI input', { filename, bytes: buf.length });
  const form = new FormData();
  form.append('image', new Blob([buf]), filename);
  form.append('overwrite', 'true');
  const res = await fetch(normBaseUrl(baseUrl) + '/upload/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error('上传到 ComfyUI 失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

export async function queuePrompt(baseUrl, workflow, clientId) {
  logger.debug('ComfyUI 提交工作流', { nodes: Object.keys(workflow).length });
  const res = await fetch(normBaseUrl(baseUrl) + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
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
    const res = await fetch(normBaseUrl(baseUrl) + '/history/' + promptId);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function getQueue(baseUrl) {
  try {
    const res = await fetch(normBaseUrl(baseUrl) + '/queue');
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
export async function generate(baseUrl, workflow, { timeoutMs = 30 * 60 * 1000, pollMs = 1500, onStatus, onSubmitted } = {}) {
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

  const deadline = Date.now() + timeoutMs;
  const finish = (entry) => {
    const outputs = collectOutputs(entry.outputs);
    try { ws?.close(); } catch {}
    return { prompt_id, outputs, entry };
  };
  while (Date.now() < deadline) {
    const h = await getHistory(baseUrl, prompt_id);
    if (h && h[prompt_id]) {
      const entry = h[prompt_id];
      if (entry.status?.status_str === 'error') {
        throw new Error('ComfyUI 执行出错: ' + JSON.stringify(entry.status?.messages || entry.status).slice(0, 1000));
      }
      return finish(entry);
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

// 调用 ComfyUI /free：卸载全部模型 + 清空显存缓存。
// 注意该端点只设置队列 flag，实际清理发生在「下一个任务执行完成后」（main.py 执行循环消费）。
// 用途：连续生成多个视频后释放 dynamic-vram 累积的显存状态，防止速度逐步退化。
export async function freeComfy(baseUrl) {
  const res = await fetch(normBaseUrl(baseUrl) + '/free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
  if (!res.ok) throw new Error('ComfyUI /free 失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

export async function downloadOutput(baseUrl, out) {
  const url = new URL('/view', normBaseUrl(baseUrl));
  url.searchParams.set('filename', out.filename);
  url.searchParams.set('subfolder', out.subfolder || '');
  url.searchParams.set('type', out.type || 'output');
  const res = await fetch(url);
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
  const res = await fetch(normBaseUrl(baseUrl) + '/object_info');
  if (!res.ok) throw new Error('读取 object_info 失败 ' + res.status);
  return res.json();
}
