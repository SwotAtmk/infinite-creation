import { Jobs, Projects, logger, loadConfig, checkComfyUI } from '../core/index.js';
import { hardwareMode } from '../shared/index.js';
import { createToolRuntime, runTool } from './tools.js';
import { runOpenClaudeAgent } from './openclaude-agent.js';

// 停止标记必须挂在 globalThis 上：Next.js（尤其 dev 模式）会为不同 route
// 各自打包一份本模块，模块级 Set 会导致 stop 路由设置的标记，运行中的 job
// 永远读不到（「点了停止按钮但分镜还在继续跑」的根因）。globalThis 跨模块实例共享。
const abortFlags = (globalThis.__infiniteCreationAbortFlags = globalThis.__infiniteCreationAbortFlags || new Set());
export function stopJob(jobId) {
  abortFlags.add(jobId);
  // 若任务还在排队等视频槽位，立即从队列摘除并中止——否则要等它「轮到自己」才生效，
  // 期间它的 DB 状态仍是 running，会继续挡住后续任务（见 runExclusiveVideo 注释）。
  cancelQueuedJob(jobId);
}
// 导出给 stages.js：阶段 job 必须共用这一个注册表，否则 /api/projects/[id]/stop
// 只认 job-runner 建的 job，阶段 job 停不下来。
export function isAborted(jobId) { return () => abortFlags.has(jobId); }

// 起任务即置项目运行态：前端据此显示「■ 停止」按钮（project.status==='running'）。
// 此前只有 /run、/stages 置运行态，单镜重生成/素材类任务没置 —— 提交后前端看不到停止按钮，
// 长视频/出图任务无法中止。统一到 runner 内，任何起任务的入口都生效。
export function markProjectRunning(projectId) { Projects.update(projectId, { status: 'running' }); }
// 任务收尾复位项目运行态：停止按钮随之消失。被用户停止的任务复位为 idle（而非 failed），
// 避免「主动停止」在项目卡片上显示成失败。
export function settleProject(projectId, jobId, ok) {
  // 队列里还有别的任务在跑/排队时，保持项目运行态（否则停止按钮会提前消失）
  const more = Jobs.list(projectId).some((j) => j.id !== jobId && (j.status === 'running' || j.status === 'queued'));
  if (more) return;
  const aborted = isAborted(jobId)();
  Projects.update(projectId, { status: aborted ? 'idle' : (ok ? 'done' : 'failed') });
}

// 排队态回调：任务进队时落库/广播为 queued（前端显示「排队中」），拿到槽位改回 running。
function queueState(job, emit) {
  return (st) => {
    const phase = st === 'queued' ? '排队中' : '准备';
    Jobs.update(job.id, { status: st, phase });
    emit({ phase, status: st });
  };
}

// 阶段任务收尾：同 settleProject，但复位为 idle（阶段只是批处理的一部分，不该显示 done/failed）。
export function releaseProject(projectId, jobId) {
  const more = Jobs.list(projectId).some((j) => j.id !== jobId && (j.status === 'running' || j.status === 'queued'));
  if (more) return;
  Projects.update(projectId, { status: 'idle' });
}

// 行内任务：把「在请求内同步跑完、但属于 LLM/渲染」的操作也记成一条 Job，
// 使其出现在任务列表里。不占视频队列、不改变项目运行态（这类操作由发起请求同步等待）。
export async function runInlineJob({ projectId, type, checkpoint = {}, onProgress }, fn) {
  const job = Jobs.create({ projectId, type, checkpoint });
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type, ...patch }); };
  emit({ phase: '准备', status: 'running' });
  try {
    const r = await fn();
    Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r ?? '').slice(0, 500), error: '', finishedAt: Date.now() });
    emit({ phase: '完成', detail: String(r ?? '').slice(0, 200), status: 'done' });
    return r;
  } catch (e) {
    Jobs.update(job.id, { status: 'failed', phase: '失败', error: e.message, finishedAt: Date.now() });
    emit({ phase: '失败', detail: e.message, status: 'failed' });
    throw e;
  }
}

// 失败/取消统一收尾：区分「用户取消」与「真失败」——取消状态记 cancelled、不写 error 日志。
function finishJobError(job, projectId, emit, e, logMsg, logExtra) {
  const cancelled = isAborted(job.id)();
  settleProject(projectId, job.id, false);
  const detail = cancelled ? '已取消' : (e && e.message ? e.message : String(e));
  Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '失败', error: detail, finishedAt: Date.now() });
  emit({ phase: cancelled ? '已取消' : '失败', detail, status: cancelled ? 'cancelled' : 'failed' });
  if (!cancelled) logger.error(logMsg, logExtra);
}

// ComfyUI 单队列串行执行：并发起 N 个任务只会让每个任务多等 N 倍时间，
// 排在后面的必然撞上超时且产物无人回收。按 videoConcurrency 排队放行。
// isAborted 可选：任务在排队等待期间被用户停止 → 主动放弃（拒绝），不留死等。
// 排队等待也有上限（videoQueueTimeoutMinutes，默认 120 分钟）：
// 前置任务卡死时会占住槽位不释放，没有这个上限，排队任务会永远 running、停止按钮常亮。
// jobId/onQueue：任务排队时把 job 标为 queued（前端可显示「排队中」），拿到槽位改回 running；
// 队列条目带 jobId，便于 stopJob 立即出队取消（不等它「轮到自己」）。
let videoSlots = 0;
const videoQueue = []; // [{ jobId, tryAcquire, cancel }]

// 从视频队列中立即摘除并中止某任务；返回是否确实在队列里。
export function cancelQueuedJob(jobId) {
  const i = videoQueue.findIndex((e) => e.jobId === jobId);
  if (i < 0) return false;
  const [e] = videoQueue.splice(i, 1);
  e.cancel(new Error('任务已停止（排队中）'));
  return true;
}

// baseUrl 是否指向本机。远端 LLM/ComfyUI 不占本机显存，不做互斥拦截。
function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  } catch { return false; }
}

// AMD 单卡硬约束：LLM（27B GGUF ≈15.7GB）与 ComfyUI 出片峰值不能同时常驻显存。
// 跑某一侧之前，主动确认「另一侧此刻没在跑」——即使本批根本不调用它，它的常驻权重也会
// 吃掉显存，这正是要防的爆显存/死机。仅 AMD 且对端为「本机」时生效；探不到 = 没在跑 = 放行。
export async function assertServiceExclusive(need, cfg) {
  cfg = cfg || loadConfig();
  if (hardwareMode(cfg) !== 'amd') return;
  if (need === 'llm') {
    const comfyBase = cfg.comfyui && cfg.comfyui.baseUrl;
    if (!isLocalBaseUrl(comfyBase)) return;
    const st = await checkComfyUI(comfyBase);
    if (st.ok) {
      throw new Error('检测到 ComfyUI 正在运行（' + comfyBase + '）：LLM 与 ComfyUI 不能同时常驻显存。请先关闭 ComfyUI，再跑 LLM 阶段。');
    }
    return;
  }
  if (need === 'comfyui') {
    const base = String((cfg.llm && cfg.llm.baseUrl) || '').replace(/\/+$/, '');
    if (!isLocalBaseUrl(base)) return;
    let up = false;
    try {
      const r = await fetch(base + '/models', { signal: AbortSignal.timeout(5000) });
      up = r.ok;
    } catch { up = false; }
    if (up) {
      throw new Error('检测到 LLM 服务仍在运行（' + base + '）：LLM 与 ComfyUI 不能同时常驻显存。请先关闭 LLM，再跑渲染阶段。');
    }
  }
}

// 导出给 stages.js：阶段 job 若不排队，可与手动「重新生成」并发提交到 ComfyUI，
// 后者必然撞上超时且产物无人回收（同 runExclusiveVideo 注释里的结论）。
// need='llm'|'comfyui'：拿到槽位后、真正执行前做一次「另一侧服务没在跑」的互斥检查。
export function runExclusiveVideo(fn, isAborted, { queueTimeoutMs, jobId, onQueue, need } = {}) {
  return new Promise((resolve, reject) => {
    const acquire = () => {
      videoSlots++;
      Promise.resolve()
        // 排队等待期间对端可能被拉起，故在拿到槽位、真正执行前再查一次；失败即任务失败，槽位照常释放。
        .then(() => (need ? assertServiceExclusive(need) : undefined))
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          videoSlots--;
          const next = videoQueue.shift();
          if (next) next.tryAcquire();
        });
    };
    const limit = Math.max(1, Number(loadConfig().generation?.videoConcurrency) || 1);
    if (videoSlots < limit) { acquire(); return; }

    // 排队前先看停止标记：已被停止的任务不再占队列
    if (isAborted && isAborted()) {
      reject(new Error('任务在排队等待视频槽位时已被停止'));
      return;
    }
    if (onQueue) onQueue('queued');
    // 排队等待上限：videoSlots 不释放说明前置任务卡死，主动放弃而不是无限等
    const waitMax = queueTimeoutMs || (Number(loadConfig().generation?.videoQueueTimeoutMinutes) || 120) * 60 * 1000;
    let timer;
    const entry = {
      jobId,
      tryAcquire: () => {
        clearTimeout(timer);
        if (isAborted && isAborted()) return reject(new Error('任务在排队等待视频槽位时已被停止'));
        if (onQueue) onQueue('running'); // 从 queued 转 running
        acquire();
      },
      cancel: (err) => { clearTimeout(timer); reject(err); },
    };
    timer = setTimeout(() => {
      const i = videoQueue.indexOf(entry);
      if (i >= 0) videoQueue.splice(i, 1);
      reject(new Error('等待视频槽位超时（' + Math.round(waitMax / 60000) + ' 分钟）。前置任务疑似卡死，本任务已主动放弃。'));
    }, waitMax);
    videoQueue.push(entry);
  });
}

// 后台任务：创建成片（全自动流水线）
// renderDisabled=true 时本批只跑 LLM 文本（如「重新生成本章分镜」= 清空本章分镜后重新拆分、
// 只写分镜/提示词），绝不提交 ComfyUI。
export function startCreateJob({ projectId, chapter, onProgress, beforeRun, renderDisabled }) {
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在');
  // AMD 单卡硬约束：LLM（27B GGUF ≈15.7GB）与 ComfyUI 出片峰值不能同时常驻。
  // 整条流水线（renderDisabled=false）会一边用 LLM 写文本、一边提交 ComfyUI 渲染，正是会爆显存/死机的组合。
  // 按设计必须拆批：先跑「LLM 创作」写文本，再跑渲染阶段（见 stages.js 的 preflight）。
  if (!renderDisabled && hardwareMode(loadConfig()) === 'amd') {
    throw new Error('本机为 AMD 单卡：LLM 与 ComfyUI 不能同时常驻，整条流水线会同时占用两者。请改用「分阶段运行」——先只勾「LLM 创作」写文本，再只勾「资产图 / 音色 / 分镜视频」出素材与视频（两批之间按需切换本机服务）。');
  }
  const job = Jobs.create({ projectId, type: 'create', checkpoint: chapter ? { subject: chapter } : {} });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, ...patch };
    if (onProgress) onProgress(p);
  };

  const task = async () => {
    // 「重置类」副作用（如重新生成分镜前清空本章分镜）放到真正拿到槽位、开始执行前才做：
    // 排队中被取消则一行数据都不动，已 done 的结果得以保留。
    if (beforeRun) await beforeRun();
    return runOpenClaudeAgent({
      projectId, chapter, jobId: job.id,
      onProgress: (patch) => {
        Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
        emit(patch);
      },
      isAborted: isAborted(job.id),
      renderDisabled: !!renderDisabled,
    });
  };

  // openclaude（@gitlawb/openclaude）作为 Agent 运行时：SDK 进程内驱动，工具直接走本工程 runTool。
  // 整条流水线本身是串行的，但用户可能同时手动重生成单个分镜，故整job 也走视频闸门。
  // 纯 LLM 批次同样要走闸门：它虽然不提交 ComfyUI，但会把 27B 权重常驻显存，与正在跑的渲染 job
  // 并发时两者同时占用显存（正是要防的爆显存场景，见 stages.js 为何拆批）。故一律串行。
  runExclusiveVideo(task, isAborted(job.id), { jobId: job.id, need: renderDisabled ? 'llm' : 'comfyui', onQueue: queueState(job, emit) })
    .then((summary) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(summary || '').slice(0, 2000), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(summary || ''), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 创建失败', { projectId, error: e.message });
    });

  return job;
}

// 后台任务：重生成某章全部视频（用 generate_chapter_videos force=true 覆盖，不预先清空分镜/视频）。
// 非破坏性：排队中被取消不动数据；执行中取消，已完成的镜头仍是 done（generateShotVideo 会恢复）。
export function startChapterVideoJob({ projectId, chapter, onProgress }) {
  const job = Jobs.create({ projectId, type: 'chapter-video', checkpoint: { subject: chapter } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, chapter, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id, chapter,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runExclusiveVideo(() => runTool(ctx, 'generate_chapter_videos', { chapter, force: true }), isAborted(job.id), { jobId: job.id, need: 'comfyui', onQueue: queueState(job, emit) })
    .then((r) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 章节视频重生成失败', { projectId, chapter, error: e.message });
    });
  return job;
}

// 后台任务：单分镜重生成（render=false 只做 LLM 改写提示词，不提交 ComfyUI）
export function startRegenerateJob({ projectId, shotId, feedback, render, onProgress }) {
  // AMD 单卡：带反馈且要渲染 = 先 LLM 改写提示词、再 ComfyUI 出片，两服务必须同时常驻 → 必爆显存。
  // 按设计拆两步：先「只做 LLM，不渲染」改写提示词；再关 LLM、起 ComfyUI，用不带反馈的「重生成视频」出片。
  if (render !== false && feedback && hardwareMode(loadConfig()) === 'amd') {
    throw new Error('本机为 AMD 单卡：带反馈重生成会同时占用 LLM（改写提示词）与 ComfyUI（渲染），两者不能同时常驻。请分两步：先在弹窗里选「否 · 只做 LLM，不渲染」按反馈改写提示词；再关闭 LLM、启动 ComfyUI，用不带反馈的「重新生成视频」出片。');
  }
  const job = Jobs.create({ projectId, type: 'regenerate', checkpoint: { subject: shotId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, shotId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  const task = () => runTool(ctx, 'regenerate_shot', { shot_id: shotId, feedback: feedback || undefined, render: render !== false });
  // 纯 LLM 改写（render=false）也走闸门：它要拉起 LLM（27B 常驻显存），与并发渲染 job 抢显存。
  runExclusiveVideo(task, isAborted(job.id), { jobId: job.id, need: render === false ? 'llm' : 'comfyui', onQueue: queueState(job, emit) })
    .then((r) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 重生成失败', { projectId, shotId, error: e.message });
    });
  return job;
}

// 后台任务：单个资产生成图片（确定性，复用 generate_asset_image 工具）
export function startAssetImageJob({ projectId, assetId, mode = 't2i', prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'asset-image', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    // 渲染 job：本批零 LLM（换装/年龄的视觉精修等 LLM 步骤在此跳过），避免与 ComfyUI 抢显存
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  const toolName = mode === 'i2i' ? 'edit_asset_image' : 'generate_asset_image';
  runExclusiveVideo(() => runTool(ctx, toolName, { asset_id: assetId, prompt: prompt || undefined }), isAborted(job.id), { jobId: job.id, need: 'comfyui', onQueue: queueState(job, emit) })
    .then((r) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 资产图生成失败', { projectId, assetId, mode, error: e.message });
    });
  return job;
}

// 后台任务：单个资产设计音色（确定性，复用 design_voice 工具）
export function startAssetVoiceJob({ projectId, assetId, text, voiceDescription, onProgress }) {
  const job = Jobs.create({ projectId, type: 'voice-design', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runExclusiveVideo(() => runTool(ctx, 'design_voice', { asset_id: assetId, text, voice_description: voiceDescription }), isAborted(job.id), { jobId: job.id, need: 'comfyui', onQueue: queueState(job, emit) })
    .then((r) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 音色设计失败', { projectId, assetId, error: e.message });
    });
  return job;
}

// 后台任务：人物换装（复用 change_outfit 工具，产出服装资产）
export function startCostumeJob({ projectId, characterId, outfit, prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'costume', checkpoint: { subject: characterId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, characterId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runExclusiveVideo(() => runTool(ctx, 'change_outfit', { character_id: characterId, outfit, prompt: prompt || undefined }), isAborted(job.id), { jobId: job.id, need: 'comfyui', onQueue: queueState(job, emit) })
    .then((r) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 换装失败', { projectId, characterId, error: e.message });
    });
  return job;
}

// 后台任务：人物年龄变体（复用 change_age 工具，产出 age 资产）
export function startAgeJob({ projectId, characterId, age, prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'age', checkpoint: { subject: characterId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, characterId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runExclusiveVideo(() => runTool(ctx, 'change_age', { character_id: characterId, age, prompt: prompt || undefined }), isAborted(job.id), { jobId: job.id, need: 'comfyui', onQueue: queueState(job, emit) })
    .then((r) => {
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 年龄变体失败', { projectId, characterId, error: e.message });
    });
  return job;
}

export function activeJobOf(projectId) {
  return Jobs.list(projectId).find((j) => j.status === 'running');
}
