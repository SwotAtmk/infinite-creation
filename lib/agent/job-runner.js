import { Jobs, Projects, logger, loadConfig } from '../core/index.js';
import { createToolRuntime, runTool } from './tools.js';
import { runOpenClaudeAgent } from './openclaude-agent.js';

const abortFlags = new Set();
export function stopJob(jobId) { abortFlags.add(jobId); }
// 导出给 stages.js：阶段 job 必须共用这一个注册表，否则 /api/projects/[id]/stop
// 只认 job-runner 建的 job，阶段 job 停不下来。
export function isAborted(jobId) { return () => abortFlags.has(jobId); }

// ComfyUI 单队列串行执行：并发起 N 个任务只会让每个任务多等 N 倍时间，
// 排在后面的必然撞上超时且产物无人回收。按 videoConcurrency 排队放行。
let videoSlots = 0;
const videoQueue = [];
// 导出给 stages.js：阶段 job 若不排队，可与手动「重新生成」并发提交到 ComfyUI，
// 后者必然撞上超时且产物无人回收（同 runExclusiveVideo 注释里的结论）。
export function runExclusiveVideo(fn) {
  return new Promise((resolve, reject) => {
    const acquire = () => {
      videoSlots++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          videoSlots--;
          const next = videoQueue.shift();
          if (next) next();
        });
    };
    const limit = Math.max(1, Number(loadConfig().generation?.videoConcurrency) || 1);
    if (videoSlots < limit) acquire();
    else videoQueue.push(acquire);
  });
}

// 后台任务：创建成片（全自动流水线）
export function startCreateJob({ projectId, chapter, onProgress }) {
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在');
  const job = Jobs.create({ projectId, type: 'create' });
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, ...patch };
    if (onProgress) onProgress(p);
  };

  // openclaude（@gitlawb/openclaude）作为 Agent 运行时：SDK 进程内驱动，工具直接走本工程 runTool。
  // 整条流水线本身是串行的，但用户可能同时手动重生成单个分镜，故整job 也走视频闸门。
  runExclusiveVideo(() => runOpenClaudeAgent({
    projectId, chapter, jobId: job.id,
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
    isAborted: isAborted(job.id),
  }))
    .then((summary) => {
      Projects.update(projectId, { status: 'done' });
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(summary || '').slice(0, 2000), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(summary || ''), status: 'done' });
    })
    .catch((e) => {
      Projects.update(projectId, { status: 'failed' });
      Jobs.update(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() });
      emit({ phase: '失败', detail: e.message, status: 'failed' });
      logger.error('job: 创建失败', { projectId, error: e.message });
    });

  return job;
}

// 后台任务：单分镜重生成（render=false 只做 LLM 改写提示词，不提交 ComfyUI，不占视频闸门）
export function startRegenerateJob({ projectId, shotId, feedback, render, onProgress }) {
  const job = Jobs.create({ projectId, type: 'regenerate' });
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, shotId, ...patch };
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
  (render === false ? task() : runExclusiveVideo(task))
    .then((r) => {
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      Jobs.update(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() });
      emit({ phase: '失败', detail: e.message, status: 'failed' });
      logger.error('job: 重生成失败', { projectId, shotId, error: e.message });
    });
  return job;
}

// 后台任务：单个资产生成图片（确定性，复用 generate_asset_image 工具）
export function startAssetImageJob({ projectId, assetId, mode = 't2i', prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'asset-image' });
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, assetId, ...patch };
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
  const toolName = mode === 'i2i' ? 'edit_asset_image' : 'generate_asset_image';
  runTool(ctx, toolName, { asset_id: assetId, prompt: prompt || undefined })
    .then((r) => {
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      Jobs.update(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() });
      emit({ phase: '失败', detail: e.message, status: 'failed' });
      logger.error('job: 资产图生成失败', { projectId, assetId, mode, error: e.message });
    });
  return job;
}

// 后台任务：单个资产设计音色（确定性，复用 design_voice 工具）
export function startAssetVoiceJob({ projectId, assetId, text, voiceDescription, onProgress }) {
  const job = Jobs.create({ projectId, type: 'voice-design' });
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, assetId, ...patch };
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
  runTool(ctx, 'design_voice', { asset_id: assetId, text, voice_description: voiceDescription })
    .then((r) => {
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      Jobs.update(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() });
      emit({ phase: '失败', detail: e.message, status: 'failed' });
      logger.error('job: 音色设计失败', { projectId, assetId, error: e.message });
    });
  return job;
}

// 后台任务：人物换装（复用 change_outfit 工具，产出服装资产）
export function startCostumeJob({ projectId, characterId, outfit, prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'costume' });
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, characterId, ...patch };
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
  runTool(ctx, 'change_outfit', { character_id: characterId, outfit, prompt: prompt || undefined })
    .then((r) => {
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: String(r), status: 'done' });
    })
    .catch((e) => {
      Jobs.update(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() });
      emit({ phase: '失败', detail: e.message, status: 'failed' });
      logger.error('job: 换装失败', { projectId, characterId, error: e.message });
    });
  return job;
}

export function activeJobOf(projectId) {
  return Jobs.list(projectId).find((j) => j.status === 'running');
}
