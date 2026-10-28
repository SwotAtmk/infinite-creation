// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, Jobs, Queue } from '@/lib/core/index.js';
import { startRegenerateJob, activeJobOfChapter } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  // 必须确认分镜属于本项目：与 shots/[sid] PATCH 保持一致，否则可用他项目的 sid
  // 借道本项目 id 生成视频（产物写进本项目目录、却用的是别人的分镜数据）。
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  // 同一分镜已有运行中/排队中的重生成任务：直接返回原任务，不再新建。
  // 防的是「重复点击 / 网络重试 / 直接调接口」造成的同一镜重复渲染与二次扣费。
  const active = Jobs.list(id).find(
    (j) =>
      (j.status === 'running' || j.status === 'queued') &&
      j.type === 'regenerate' &&
      j.checkpoint &&
      j.checkpoint.subject === sid,
  );
  if (active) return NextResponse.json({ ...active, deduped: true });
  // 本章正在跑整条流水线/阶段任务：单镜按钮必须锁定，避免同一镜被并行生成、重复扣费。
  const chapterJob = activeJobOfChapter(id, shot.chapter);
  if (chapterJob && chapterJob.type !== 'regenerate') {
    return NextResponse.json(
      { error: '本章任务正在运行（' + (chapterJob.phase || '准备中') + '），请等本章任务结束或先停止本章', code: 'CHAPTER_RUNNING', jobId: chapterJob.id },
      { status: 409 },
    );
  }
  // 同一分镜可能正被流水线 / 整章生成任务渲染：队列条目是跨任务的唯一去重依据。
  const queued = Queue.activeByDedupe('shot:' + sid);
  if (queued) {
    const owner = queued.jobId ? Jobs.get(queued.jobId) : null;
    if (owner) return NextResponse.json({ ...owner, deduped: true });
    return NextResponse.json(
      { error: '该分镜已有渲染任务在排队或执行中', code: 'ALREADY_RENDERING', queueId: queued.id },
      { status: 409 },
    );
  }
  // 不再因「已有任务」拒绝：提交即入全局队列，等前面任务跑完自动逐个执行（ComfyUI 单队列）
  try {
    const job = startRegenerateJob({ projectId: id, shotId: sid, feedback: body?.feedback, render: body?.render, append: body?.append, onProgress: (p) => broadcast(p) });
    return NextResponse.json(job);
  } catch (e) {
    if (e && e.code === 'INSUFFICIENT_CREDITS') return NextResponse.json({ error: e.message, code: e.code }, { status: 402 });
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
