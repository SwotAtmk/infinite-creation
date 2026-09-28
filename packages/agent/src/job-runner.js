import { Jobs, Projects, logger } from '@ic/core';
import { createToolRuntime, runTool } from './tools.js';
import { runOpenClaudeAgent } from './openclaude-agent.js';

const abortFlags = new Set();
export function stopJob(jobId) { abortFlags.add(jobId); }
function isAborted(jobId) { return () => abortFlags.has(jobId); }

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
  runOpenClaudeAgent({
    projectId, chapter, jobId: job.id,
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
    isAborted: isAborted(job.id),
  })
    .then((summary) => {
      Projects.update(projectId, { status: 'done' });
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(summary || '').slice(0, 2000), finishedAt: Date.now() });
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

// 后台任务：单分镜重生成
export function startRegenerateJob({ projectId, shotId, feedback, onProgress }) {
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
  runTool(ctx, 'regenerate_shot', { shot_id: shotId, feedback: feedback || undefined })
    .then((r) => {
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), finishedAt: Date.now() });
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
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), finishedAt: Date.now() });
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
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), finishedAt: Date.now() });
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
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r), finishedAt: Date.now() });
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
