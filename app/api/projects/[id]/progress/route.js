// 统一的流程进度：一次请求返回项目级 / 章节级 / 四个阶段的「已完成 / 总数 / 待办 / 百分比」，
// 供 Studio 的进度条、任务抽屉与日志页共用。数字与 pendingByStage 的待办口径一致，
// 避免界面显示「100%」但后端仍在补跑。
import { NextResponse } from 'next/server';
import { Assets, Chapters, Jobs, Projects, Shots } from '@/lib/core/index.js';
import { pendingByStage } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

const IMAGE_ASSET_CATEGORIES = ['character', 'scene', 'prop', 'other'];

function stageOf(todo, total, items = []) {
  const t = Math.max(0, Number(total) || 0);
  const td = Math.max(0, Math.min(t || todo, Number(todo) || 0));
  const done = Math.max(0, t - td);
  return { total: t, done, todo: td, percent: t ? Math.round((done / t) * 100) : 0, items };
}

export async function GET(_req, { params }) {
  const { id } = await params;
  const project = Projects.get(id);
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  const assets = Assets.list(id);
  const shots = Shots.list(id);
  const chapters = Chapters.list(id);
  const jobs = Jobs.list(id);
  const pending = pendingByStage(id);

  const imageAssets = assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category));
  const chars = assets.filter((a) => a.category === 'character');

  const llmTotal = imageAssets.length + shots.length + (shots.length ? 0 : 1);
  const stages = {
    llm: stageOf(pending.llm?.todo || 0, llmTotal, pending.llm?.items || []),
    image: stageOf(pending.image?.todo || 0, imageAssets.length, pending.image?.items || []),
    tts: stageOf(pending.tts?.todo || 0, chars.length, pending.tts?.items || []),
    video: stageOf(pending.video?.todo || 0, shots.length, pending.video?.items || []),
  };

  const chapterItems = chapters.map((c) => {
    const ss = shots.filter((s) => s.chapter === c.title);
    const done = ss.filter((s) => s.status === 'done' && s.video_path).length;
    const failed = ss.filter((s) => s.status === 'failed').length;
    const generating = ss.filter((s) => s.status === 'generating' || s.status === 'running').length;
    return {
      id: c.id,
      title: c.title,
      seq: c.seq,
      status: c.status,
      shots: { total: ss.length, done, failed, generating, pending: Math.max(0, ss.length - done - failed - generating) },
      percent: ss.length ? Math.round((done / ss.length) * 100) : 0,
    };
  });

  const stageList = Object.values(stages).filter((s) => s.total > 0);
  const overallPercent = stageList.length ? Math.round(stageList.reduce((n, s) => n + s.percent, 0) / stageList.length) : 0;
  const overallDone = stageList.reduce((n, s) => n + s.done, 0);
  const overallTotal = stageList.reduce((n, s) => n + s.total, 0);

  const activeJobs = jobs
    .filter((j) => j.status === 'running' || j.status === 'queued')
    .map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      phase: j.phase,
      detail: j.detail,
      startedAt: j.startedAt,
      checkpoint: j.checkpoint,
      progress: j.progress,
    }));

  return NextResponse.json({
    updatedAt: Date.now(),
    projectStatus: project.status,
    overall: { percent: overallPercent, done: overallDone, total: overallTotal },
    stages,
    chapters: { total: chapters.length, items: chapterItems },
    assets: {
      total: assets.length,
      image: { total: imageAssets.length, done: stages.image.done },
      voice: { total: chars.length, done: stages.tts.done },
      music: assets.filter((a) => a.category === 'music').length,
    },
    shots: {
      total: shots.length,
      done: stages.video.done,
      generating: shots.filter((s) => s.status === 'generating' || s.status === 'running').length,
      failed: shots.filter((s) => s.status === 'failed').length,
      pending: Math.max(0, shots.length - stages.video.done - shots.filter((s) => s.status === 'failed').length),
    },
    activeJobs,
  });
}
