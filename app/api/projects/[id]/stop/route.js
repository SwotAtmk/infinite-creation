// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Jobs, loadConfig, interruptTask } from '@/lib/core/index.js';
import { stopJob, holdsRenderSlot } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function POST(_req, { params }) {
  const { id } = await params;
  // 同时停「执行中」和「排队中」的任务：排队中的会被立即从队列摘除并中止（stopJob → cancelQueuedJob）
  const jobs = Jobs.list(id).filter((j) => j.status === 'running' || j.status === 'queued');
  for (const j of jobs) stopJob(j.id);
  Projects.update(id, { status: 'idle' });
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
  return NextResponse.json({ stopped: jobs.length });
}
