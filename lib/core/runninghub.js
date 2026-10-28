import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './utils.js';

const API_HOST = 'https://www.runninghub.cn';

function apiKeyOf(cfg) { return String(cfg?.comfyui?.apiKey || '').trim(); }

// 通用 POST：云端渲染统一响应 { code, msg, data }，code=0 成功。
async function rhPost(pathName, body, apiKey, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(API_HOST + pathName, {
    method: 'POST',
    headers: {
      Host: 'www.runninghub.cn',
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('云端渲染请求失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) throw new Error('云端渲染返回错误 code=' + j.code + ': ' + (j.msg || j.message || ''));
  return j;
}

// 上传文件，返回 fileName（写进工作流 LoadImage/LoadAudio/LoadVideo 等节点）
export async function runninghubUpload(cfg, localPath) {
  const buf = fs.readFileSync(localPath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(localPath));
  const res = await fetch(API_HOST + '/openapi/v2/media/upload/binary', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKeyOf(cfg) },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error('云端渲染上传失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json();
  if (j.code !== 0) throw new Error('云端渲染上传失败 code=' + j.code + ': ' + (j.message || j.msg || ''));
  // 返回体缺 fileName 时必须报错：静默返回 undefined 会让工作流里对应媒体槽为空，
  // ComfyUI 报「缺输入」的隐晦错误，而真正原因（上传未成功）在日志里看不到。
  const fileName = j.data?.fileName;
  if (!fileName) throw new Error('云端渲染上传未返回 fileName：' + JSON.stringify(j).slice(0, 300));
  return fileName;
}

// 提交任务，返回 { taskId, taskStatus }
export async function runninghubSubmit(cfg, workflowJson, clientId) {
  const body = {
    randomSeed: true,
    usePersonalQueue: false,
    clientId,
    apiKey: apiKeyOf(cfg),
    workflow: workflowJson,
    retainSeconds: 0,
    addMetadata: false,
    workflowId: 1,
  };
  if (cfg?.comfyui?.tier === 'plus') body.instanceType = 'plus';
  const j = await rhPost('/task/openapi/create', body, apiKeyOf(cfg), { timeoutMs: 60_000 });
  return { taskId: j.data?.taskId, taskStatus: j.data?.taskStatus };
}

// 查询状态，返回 "QUEUED"|"RUNNING"|"FAILED"|"SUCCESS"
export async function runninghubStatus(cfg, taskId) {
  const j = await rhPost('/task/openapi/status', { apiKey: apiKeyOf(cfg), taskId }, apiKeyOf(cfg), { timeoutMs: 15_000 });
  return j.data;
}

// 查询结果，返回 [{ fileUrl, fileType, nodeId, ... }]
export async function runninghubOutputs(cfg, taskId) {
  const j = await rhPost('/task/openapi/outputs', { apiKey: apiKeyOf(cfg), taskId }, apiKeyOf(cfg), { timeoutMs: 15_000 });
  return j.data || [];
}

// 取消任务
export async function runninghubCancel(cfg, taskId) {
  await rhPost('/task/openapi/cancel', { apiKey: apiKeyOf(cfg), taskId }, apiKeyOf(cfg), { timeoutMs: 15_000 });
}

// 检查连接（用账户信息接口验证 apiKey）
export async function runninghubCheck(cfg) {
  try {
    const res = await fetch(API_HOST + '/uc/openapi/accountStatus', {
      method: 'POST',
      headers: {
        Host: 'www.runninghub.cn',
        Authorization: 'Bearer ' + apiKeyOf(cfg),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apikey: apiKeyOf(cfg) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const j = await res.json();
    if (j.code !== 0) throw new Error(j.msg || j.message || ('code=' + j.code));
    return { ok: true, system: '云端渲染', device: '', ckAttention: false, ckKitchen: '', vramFree: 0, dynamicVram: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 下载 fileUrl，返回 Buffer（含「非文件内容」content-type 校验）
export async function runninghubDownload(fileUrl) {
  const res = await fetch(fileUrl, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error('下载输出失败 ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = String(res.headers?.get?.('content-type') || '');
  if (/json|xml|text\/plain/.test(ct)) {
    throw new Error('下载输出失败（返回了非文件内容）：' + buf.toString('utf8').slice(0, 300));
  }
  return buf;
}

const KIND_IMAGE = /png|jpe?g|webp/i;
const KIND_VIDEO = /mp4|webm|mov|gif|avi|mkv|m4v/i;
const KIND_AUDIO = /wav|flac|mp3|aac|m4a|ogg/i;

function kindOf(item) {
  const ext = String(item?.fileType || '').split('.').pop() || String(item?.fileUrl || '').split('.').pop() || '';
  if (KIND_IMAGE.test(ext)) return 'images';
  if (KIND_VIDEO.test(ext)) return 'videos';
  if (KIND_AUDIO.test(ext)) return 'audio';
  return 'images';
}

// 把 云端渲染产物项转换成与 collectOutputs 兼容的结构（含 kind + fileUrl + filename）
export function toOutputItem(item) {
  const fileUrl = item?.fileUrl || '';
  const filename = fileUrl.split('/').pop() || '';
  return { ...item, filename, fileUrl, kind: kindOf(item), type: 'output', subfolder: '' };
}

// 提交 + 轮询 + 转换产物，返回 { prompt_id, outputs, entry }（结构对齐原生 generate）
const TERMINAL_STATUS = new Set(['SUCCESS', 'FAILED', 'CANCEL']);

// 停止/超时后不能立刻释放本地并发槽位：取消接口成功只代表「已请求取消」，
// 上游可能还在 RUNNING。必须等到 SUCCESS/FAILED/CANCEL 才算真正释放。
// 否则下一批任务会继续提交，直接撞上账号并发上限。
async function waitForTerminal(cfg, taskId, { maxMs = 5 * 60 * 1000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const st = await runninghubStatus(cfg, taskId);
      if (st) last = st;
      if (TERMINAL_STATUS.has(st)) return st;
    } catch {
      /* 网络抖动继续等，不能让本地提前放行 */
    }
    await sleep(pollMs);
  }
  return last || 'UNKNOWN';
}

export async function runninghubGenerate(cfg, workflow, opts = {}) {
  const clientId = crypto.randomUUID();
  const { taskId } = await runninghubSubmit(cfg, JSON.stringify(workflow), clientId);
  if (opts.onSubmitted) opts.onSubmitted(taskId);
  if (opts.onStatus) opts.onStatus({ kind: 'queued', prompt_id: taskId });

  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'QUEUED';
  const fail = (message, code, started) => {
    const e = new Error(message);
    e.code = code;
    e.providerTaskId = taskId;
    e.providerStatus = lastStatus;
    return e;
  };
  while (Date.now() < deadline) {
    if (opts.isAborted && opts.isAborted()) {
      // 取消前再查一次状态：能明确知道是否已经 RUNNING（API 不返回费用，只能按状态判断）
      let started = lastStatus === 'RUNNING';
      try {
        const st = await runninghubStatus(cfg, taskId);
        lastStatus = st || lastStatus;
        if (st === 'RUNNING') started = true;
        if (st === 'SUCCESS') {
          // 停止请求与完成撞车：产物已经生成，直接取回，避免“扣了费却没有产物”。
          const items = await runninghubOutputs(cfg, taskId);
          const outputs = items.map(toOutputItem);
          return { prompt_id: taskId, outputs, entry: { outputs: items } };
        }
      } catch { started = true; }
      let cancelOk = true;
      try { await runninghubCancel(cfg, taskId); } catch { cancelOk = false; }
      // 取消成功后等上游真正进入终态；仍在 RUNNING 时保持本地槽位占用，避免并发穿透。
      if (opts.onStatus) opts.onStatus({ kind: 'waiting_release', message: '等待云端任务释放并发槽位' });
      const terminal = await waitForTerminal(cfg, taskId);
      if (terminal === 'SUCCESS') {
        const items = await runninghubOutputs(cfg, taskId);
        const outputs = items.map(toOutputItem);
        return { prompt_id: taskId, outputs, entry: { outputs: items } };
      }
      const stillRunning = !TERMINAL_STATUS.has(terminal);
      const e = fail('任务已停止（云端任务可能已产生费用）', 'PROVIDER_CANCELED', started || !cancelOk || stillRunning);
      e.providerStillRunning = stillRunning;
      throw e;
    }
    const st = await runninghubStatus(cfg, taskId);
    const prevStatus = lastStatus;
    lastStatus = st || lastStatus;
    if (st === 'SUCCESS') {
      const items = await runninghubOutputs(cfg, taskId);
      const outputs = items.map(toOutputItem);
      return { prompt_id: taskId, outputs, entry: { outputs: items } };
    }
    if (st === 'FAILED') {
      // 失败通常也跑过 GPU；默认按已开始计费，可用 always_refund 改回全退。
      throw fail('云端渲染任务失败：taskId=' + taskId, 'PROVIDER_FAILED', true);
    }
    if (st === 'CANCEL') {
      throw fail('云端渲染任务已被上游取消：taskId=' + taskId, 'PROVIDER_CANCELED', prevStatus === 'RUNNING');
    }
    await sleep(pollMs);
  }
  // 超时：先查一次状态决定是否已开始，再取消远端任务，避免继续烧 GPU。
  let timeoutStarted = lastStatus === 'RUNNING';
  try {
    const st = await runninghubStatus(cfg, taskId);
    if (st === 'RUNNING' || st === 'SUCCESS') timeoutStarted = true;
    if (st) lastStatus = st;
  } catch { timeoutStarted = true; }
  try { await runninghubCancel(cfg, taskId); } catch {}
  if (opts.onStatus) opts.onStatus({ kind: 'waiting_release', message: '等待云端任务释放并发槽位' });
  const terminal = await waitForTerminal(cfg, taskId);
  if (terminal === 'SUCCESS') {
    const items = await runninghubOutputs(cfg, taskId);
    const outputs = items.map(toOutputItem);
    return { prompt_id: taskId, outputs, entry: { outputs: items } };
  }
  const stillRunning = !TERMINAL_STATUS.has(terminal);
  const e = fail('云端生成超时（' + Math.round(timeoutMs / 60000) + ' 分钟），taskId=' + taskId, 'PROVIDER_TIMEOUT', timeoutStarted || stillRunning);
  e.providerStillRunning = stillRunning;
  throw e;
}
