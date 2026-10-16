import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './utils.js';

const API_HOST = 'https://www.runninghub.cn';

function apiKeyOf(cfg) { return String(cfg?.comfyui?.apiKey || '').trim(); }

// 通用 POST：RunningHub 统一响应 { code, msg, data }，code=0 成功。
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
  if (!res.ok) throw new Error('RunningHub 请求失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) throw new Error('RunningHub 返回错误 code=' + j.code + ': ' + (j.msg || j.message || ''));
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
  if (!res.ok) throw new Error('RunningHub 上传失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json();
  if (j.code !== 0) throw new Error('RunningHub 上传失败 code=' + j.code + ': ' + (j.message || j.msg || ''));
  // 返回体缺 fileName 时必须报错：静默返回 undefined 会让工作流里对应媒体槽为空，
  // ComfyUI 报「缺输入」的隐晦错误，而真正原因（上传未成功）在日志里看不到。
  const fileName = j.data?.fileName;
  if (!fileName) throw new Error('RunningHub 上传未返回 fileName：' + JSON.stringify(j).slice(0, 300));
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
    return { ok: true, system: 'RunningHub 云端', device: '', ckAttention: false, ckKitchen: '', vramFree: 0, dynamicVram: false };
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

// 把 RunningHub 产物项转换成与 collectOutputs 兼容的结构（含 kind + fileUrl + filename）
export function toOutputItem(item) {
  const fileUrl = item?.fileUrl || '';
  const filename = fileUrl.split('/').pop() || '';
  return { ...item, filename, fileUrl, kind: kindOf(item), type: 'output', subfolder: '' };
}

// 提交 + 轮询 + 转换产物，返回 { prompt_id, outputs, entry }（结构对齐原生 generate）
export async function runninghubGenerate(cfg, workflow, opts = {}) {
  const clientId = crypto.randomUUID();
  const { taskId } = await runninghubSubmit(cfg, JSON.stringify(workflow), clientId);
  if (opts.onSubmitted) opts.onSubmitted(taskId);
  if (opts.onStatus) opts.onStatus({ kind: 'queued', prompt_id: taskId });

  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.isAborted && opts.isAborted()) {
      try { await runninghubCancel(cfg, taskId); } catch {}
      throw new Error('任务已停止');
    }
    const st = await runninghubStatus(cfg, taskId);
    if (st === 'SUCCESS') {
      const items = await runninghubOutputs(cfg, taskId);
      const outputs = items.map(toOutputItem);
      return { prompt_id: taskId, outputs, entry: { outputs: items } };
    }
    if (st === 'FAILED') throw new Error('RunningHub 任务失败：taskId=' + taskId);
    await sleep(pollMs);
  }
  throw new Error('RunningHub 生成超时（' + Math.round(timeoutMs / 60000) + ' 分钟），taskId=' + taskId);
}
