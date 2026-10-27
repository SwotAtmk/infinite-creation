import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from './config.js';
import { Queue, Projects } from './db.js';
import { queueEnabled, runInQueue, poolOfKind } from './scheduler.js';
import { guardTexts } from './moderation.js';
import { generateTask, downloadTaskOutput, freeBackend } from './backend.js';
import { logger } from './logger.js';
import { uid } from './utils.js';
import { captureHold, holdCredits, priceForKind, recordUsage, releaseHold, walletEnabled } from './billing.js';

// 通用工作流运行器：由「工作流规格」驱动，无需逐工作流手写 builder。
// spec 结构见 lib/shared/index.js 的 WORKFLOW_SPEC_SCHEMA。
// params 键 = spec.roles 的语义角色名（positive_prompt / negative_prompt / width / height / seed / seconds / resolution / aspect_ratio / image / filename_prefix），
// 额外支持 references = [{ type:'image'|'audio'|'video', filename }]，由 spec.media 绑定。

function loadSpecSource(sourceFile) {
  const p = path.join(WORKFLOWS_DIR, sourceFile);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cloneSpecSource(sourceFile) {
  return JSON.parse(JSON.stringify(loadSpecSource(sourceFile)));
}

const MEDIA_LOADERS = {
  image: { class: 'LoadImage', field: 'image' },
  audio: { class: 'LoadAudio', field: 'audio' },
  video: { class: 'LoadVideo', field: 'file' },
};

function setInput(wf, nodeId, field, value) {
  const node = wf[nodeId];
  if (!node || !node.inputs) {
    logger.warn('工作流节点不存在，跳过写入', { node: nodeId, field });
    return;
  }
  node.inputs[field] = value;
}

function isLinkRef(v) {
  return Array.isArray(v) && typeof v[0] === 'string';
}

// 删除 spec.prune 点名的节点，以及从 spec.outputs 保存节点出发不可达的节点。
// 模板里自带硬编码文件名的占位参考图/音、以及被覆盖掉 prompt 的 LLM 改写链都要清掉：
// ComfyUI 会校验整张图，留着会因「文件不存在」或改写链缺依赖而拒绝整条 prompt。
function pruneWorkflow(wf, spec) {
  for (const id of spec.prune || []) delete wf[id];
  const roots = Object.keys(wf).filter((id) => (spec.outputs || []).includes(wf[id].class_type));
  if (!roots.length) return;
  const keep = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id) || !wf[id]) continue;
    keep.add(id);
    for (const v of Object.values(wf[id].inputs || {})) {
      if (isLinkRef(v) && wf[v[0]]) stack.push(v[0]);
    }
  }
  for (const id of Object.keys(wf)) {
    if (!keep.has(id)) delete wf[id];
  }
  // 顺带清掉指向已删节点的连线，否则 ComfyUI 校验时报缺失节点
  for (const node of Object.values(wf)) {
    for (const [field, v] of Object.entries(node.inputs || {})) {
      if (isLinkRef(v) && !wf[v[0]]) delete node.inputs[field];
    }
  }
}

// 依据 spec 构建可提交的 ComfyUI 图
export function buildWorkflow(spec, params = {}) {
  const wf = cloneSpecSource(spec.sourceFile);
  const roles = spec.roles || {};
  for (const [key, val] of Object.entries(params)) {
    if (key === 'references') continue;
    const role = roles[key];
    if (role && val != null && val !== '') setInput(wf, role.node, role.field, mapRoleValue(role, val));
  }

  const refs = params.references;
  if (spec.media && Array.isArray(refs)) {
    bindMedia(wf, spec.media, refs);
  }
  pruneWorkflow(wf, spec);
  return wf;
}

// role.map：把应用层的枚举值翻译成目标节点认识的枚举（如 '16:9' → '16:9 (Widescreen)'、'480P' → 0.5）
function mapRoleValue(role, val) {
  return role.map && role.map[val] !== undefined ? role.map[val] : val;
}

function bindMedia(wf, media, references) {
  const targetNode = wf[media.targetNode];
  if (!targetNode?.inputs) throw new Error('工作流缺少 media 承载节点：' + media.targetNode);
  const inputs = targetNode.inputs;
  // 两种字段命名：mediaField/typeField 是「第 n 个媒体 + 第 n 个类型」；fieldsByType 是按类型各有前缀
  // （MiniMax H3 的 Autogrow 输入：ref_images.ref_image_0 / ref_audios.ref_audio_0 …，各自独立编号）
  const fieldsByType = media.fieldsByType || null;
  const mediaField = media.mediaField || 'media_';
  const typeField = media.typeField ?? 'media_type_';
  const fieldPrefixes = (type) => {
    const v = fieldsByType?.[type];
    if (!v) return null;
    return Array.isArray(v) ? v : [v];
  };
  // 记录模板自带的占位 loader 节点，供后面清理（模板如 LoadAudio/LoadImage 带硬编码文件名）
  const originalLoaders = new Set();
  for (const arr of Object.values(media.reusePool || {})) for (const n of arr) originalLoaders.add(String(n));
  // 清理旧 media 字段
  const allPrefixes = fieldsByType
    ? [...new Set(Object.values(fieldsByType).flatMap((v) => (Array.isArray(v) ? v : [v])))]
    : [mediaField, typeField].filter(Boolean);
  for (const k of Object.keys(inputs)) {
    if (k === 'media' || allPrefixes.some((p) => k.startsWith(p))) delete inputs[k];
  }

  const loaders = media.loaders || MEDIA_LOADERS;
  const reusePool = media.reusePool || { image: [], audio: [], video: [] };
  const usedCount = { image: 0, audio: 0, video: 0 };
  const usedNodes = new Set();

  references.forEach((ref, i) => {
    const n = i + 1;
    const type = loaders[ref.type] ? ref.type : 'image';
    const loader = loaders[type];
    const pool = reusePool[type] || [];
    const prefixes = fieldPrefixes(type);
    // 该工作流不支持这种媒体类型（如只给图片槽的 r2v 收到 video）：跳过，不占编号
    if (fieldsByType && !prefixes.length) return;
    let nodeId;
    if (usedCount[type] < pool.length) {
      nodeId = pool[usedCount[type]];
      setInput(wf, nodeId, loader.field, ref.filename);
      usedNodes.add(nodeId);
    } else {
      nodeId = String(1000 + i);
      wf[nodeId] = { inputs: { [loader.field]: ref.filename }, class_type: loader.class, _meta: { title: loader.class } };
      usedNodes.add(nodeId);
    }
    usedCount[type]++;
    if (prefixes) {
      // 按类型各自编号，编号从 0 起（对应 ref_images.ref_image_0）
      for (const prefix of prefixes) inputs[prefix + (usedCount[type] - 1)] = [nodeId, 0];
    } else {
      inputs[mediaField + n] = [nodeId, 0];
      if (typeField) inputs[typeField + n] = type;
    }
  });

  // 删除未再引用的模板占位 loader 节点（避免 ComfyUI 校验模板里的占位音/图导致整图被拒）
  for (const nodeId of originalLoaders) {
    if (!usedNodes.has(nodeId) && wf[nodeId]) delete wf[nodeId];
  }
}

// —— 生成维护：所有 ComfyUI 生成共用的显存释放计数 ——
// AMD Dynamic VRAM 的显存累积退化不只在视频生成触发：文生图/图生图/换装/音色连续生成同样会逐步变慢
//（Comfy-Org/comfyui #13087、patientx-cfz/comfyui-rocm #114），所以在 runWorkflow（全部渲染任务的
// 必经出口）统一计数：每成功/失败跑完 N 个生成任务调一次 ComfyUI /free。
// /free 的清理实际发生在下一个任务跑完后（flag 机制），所以「每 N 个生成清一次」正好让下一批从头开始。
// N=0 / 未配置 = 关闭。读取优先新键 freeAfterEvery，兼容旧键 videoFreeAfterEvery。
// 计数器挂在 globalThis：Next 会为不同 route 各打包一份本模块，模块级变量在多个实例间不共享，
// 各自计数会让「每 N 个生成清一次」的实际频率漂移（与 job-runner / ws 的共享状态同一处置）。
const freeState = (globalThis.__icRendersSinceFree = globalThis.__icRendersSinceFree || { n: 0 });
export async function maybeFreeComfy(cfg) {
  const N = Number(cfg.generation?.freeAfterEvery ?? cfg.generation?.videoFreeAfterEvery) || 0;
  if (N <= 0) return;
  freeState.n += 1;
  if (freeState.n < N) return;
  freeState.n = 0;
  try {
    await freeBackend(cfg);
    logger.info('已调用 ComfyUI /free 释放显存（每 ' + N + ' 个生成任务一次）');
  } catch (e) {
    logger.warn('调用 ComfyUI /free 失败，继续生成（不影响当前结果）', { error: e.message });
  }
}

// 生成并返回 { prompt_id, outputs, kind }，kind 取 spec.outputs 对应的产物类别
export async function runWorkflow(cfg, spec, params, opts = {}) {
  try {
    // 生成提交前的最后一道内容审核（所有出图/出片/音频路径都会经过这里）。
    // 注意不审核 negative_prompt：它通常包含 nsfw/nude 等反向词，属于正常用法。
    await guardTexts(
      {
        positive_prompt: params?.positive_prompt,
        caption: params?.caption,
        lyrics: params?.lyrics,
        text: params?.text,
        voice_description: params?.voice_description,
      },
      { context: 'workflow:' + (spec?.id || '') },
    );
    const wf = buildWorkflow(spec, params);
    // RunningHub 云端：每一次真正的生成都进公平队列（按用户轮转、按池保底），
    // 而不是让整条流水线占住槽位。本地 ComfyUI 保持原来的整批串行闸门（见 job-runner）。
    let result;
    const kind = spec?.kind || '';
    // 视频按秒计费，其余按次（每张图 / 每个音色 / 每首音乐）
    const quantity = kind === 'r2v' ? Math.max(1, Number(params?.seconds) || 0) : 1;
    if (queueEnabled(cfg)) {
      result = await runInQueue(
        {
          jobId: opts.jobId,
          projectId: opts.projectId,
          pool: poolOfKind(spec?.kind),
          kind,
          quantity,
          chapter: opts.chapter || '',
          subject: opts.subject || '',
          isAborted: opts.isAborted,
          onQueue: opts.onQueue,
          waitMaxMs: opts.queueTimeoutMs,
          dedupeKey: opts.dedupeKey || '',
          payload: { spec: spec?.id || '', kind: spec?.kind || '' },
        },
        (item) =>
          generateTask(cfg, wf, {
            ...opts,
            // 记下远端 taskId：停止/对账时要用（取消走 runninghubCancel）
            onSubmitted: (pid) => {
              Queue.setRemote(item.id, pid);
              if (opts.onSubmitted) opts.onSubmitted(pid);
            },
          }),
      );
    } else {
      // 队列关闭（本地直连）也必须走计费，否则这条路径完全免费。
      const price = priceForKind(cfg, kind, quantity);
      const ownerId = opts.ownerId || (opts.projectId ? Projects.ownerOf(opts.projectId) || '' : '');
      const hold = walletEnabled(cfg) && ownerId && price.amount > 0
        ? holdCredits({
            ownerId,
            amount: price.amount,
            key: 'direct:' + uid(),
            jobId: opts.jobId || '',
            projectId: opts.projectId || '',
            kind,
            chapter: opts.chapter || '',
            subject: opts.subject || '',
          }, cfg)
        : null;
      try {
        result = await generateTask(cfg, wf, opts);
        if (hold) {
          captureHold(hold.id, { cfg, quantity, unitPrice: price.unitPrice, chapter: opts.chapter || '', subject: opts.subject || '' });
        }
      } catch (e) {
        if (e && e.billable && ownerId && price.amount > 0) {
          try {
            if (hold) {
              captureHold(hold.id, { cfg, quantity, unitPrice: price.unitPrice, chapter: opts.chapter || '', subject: opts.subject || '上游已开始任务', note: '上游任务已开始/失败，按策略计费' });
            } else {
              await recordUsage(
                { projectId: opts.projectId, ownerId, jobId: opts.jobId, kind, quantity, unitPrice: price.unitPrice, currency: price.currency, chapter: opts.chapter || '', subject: opts.subject || '上游已开始任务', note: '上游任务已开始/失败，按策略计费' },
                cfg,
              );
            }
            logger.info('上游任务已开始/完成但被停止，按策略计费', { jobId: opts.jobId, kind, status: e.providerStatus, code: e.code });
          } catch (billErr) {
            logger.warn('上游已开始任务的计费失败：' + billErr.message, { jobId: opts.jobId, kind });
          }
        } else {
          releaseHold(hold, e.message);
        }
        throw e;
      }
    }
    const { prompt_id, outputs } = result;
    return { prompt_id, outputs };
  } finally {
    // 无论成功失败都计数：失败的残留更值得清
    await maybeFreeComfy(cfg);
  }
}

// 从 outputs 里挑出目标类别（image/video/audio）
export function pickOutput(outputs, kind) {
  return outputs.find((o) => o.kind === kind);
}

export async function downloadToFile(cfg, out, localAbsPath) {
  const buf = await downloadTaskOutput(cfg, out);
  fs.mkdirSync(path.dirname(localAbsPath), { recursive: true });
  fs.writeFileSync(localAbsPath, buf);
  return localAbsPath;
}
