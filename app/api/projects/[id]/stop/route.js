// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Jobs, loadConfig, interruptTask } from '@/lib/core/index.js';
import { stopJob, holdsRenderSlot, jobTouchesChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const chapter = body?.chapter ? String(body.chapter) : '';
  // 同时停「执行中」和「排队中」的任务：排队中的会被立即从队列摘除并中止（stopJob → cancelQueuedJob）
  // 指定 chapter 时只停该章的任务，其他章继续跑；不指定则停整个项目。
  const active = Jobs.list(id).filter((j) => j.status === 'running' || j.status === 'queued');
  const jobs = chapter ? active.filter((j) => jobTouchesChapter(j, chapter)) : active;
  for (const j of jobs) stopJob(j.id);
  // 只有项目里确实没有活动任务了才置回空闲；其他章节还在跑时保持 running。
  const remain = Jobs.list(id).some((j) => j.status === 'running' || j.status === 'queued');
  if (!remain) Projects.update(id, { status: 'idle' });
  // 主动打断 ComfyUI 当前正在执行的任务：仅靠 abortFlag 要等 generate() 轮询到
  // 下一拍（最多数秒）才会 /interrupt；这里主动打断能让「停止」立即生效并马上释放 GPU。
  // 但只有本项目确实有任务占着槽位时才打断：行内任务（llm 参考图分析 / export 按章导出）
  // 不占 ComfyUI，而 /interrupt 是全局的——无脑打断会误杀**另一个项目**正在跑的渲染任务。
  if (jobs.some((j) => holdsRenderSlot(j.id))) {
    try {
      const cfg = loadConfig();
      await interruptTask(cfg);
    } catch {}
  }
  return NextResponse.json({ stopped: jobs.length, chapter: chapter || null });
}
