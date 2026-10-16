// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, loadConfig, interruptTask, projectDir } from '@/lib/core/index.js';
import { stopJob, holdsRenderSlot } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 删除任务记录。
// - 活动任务（执行中/排队中）：先取消（打停止标记 + 立即出队；执行中的再主动打断 ComfyUI），
//   否则排队任务仍会被执行、运行任务仍占显存。
// - 已结束任务：直接删记录。
// - 行内任务（llm 参考图分析 / export 按章导出）正在请求内同步执行：没有取消入口（停不掉），
//   删掉记录只会让「还在跑的导出/分析」变成看不见的孤儿（记录没了、活照跑），故拒绝删除。
// 只删「任务记录」与其日志，不删任务产出的素材/视频（那是资产，独立于任务记录）。
export async function DELETE(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  if (!job || job.projectId !== id) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  const running = job.status === 'running';
  const queued = job.status === 'queued';
  if (running && !holdsRenderSlot(jobId)) {
    return NextResponse.json({ error: '该任务在请求内同步执行（不占渲染队列），无法删除记录，请等它结束' }, { status: 409 });
  }
  if (running || queued) stopJob(jobId);
  if (running) { try { const cfg = loadConfig(); await interruptTask(cfg); } catch {} }
  // 清掉任务级日志文件
  try { fs.unlinkSync(path.join(projectDir(id), 'logs', jobId + '.log')); } catch {}
  if (job.logPath) { try { fs.unlinkSync(job.logPath); } catch {} }
  Jobs.remove(jobId);
  return NextResponse.json({ ok: true, cancelled: running || queued, id: jobId });
}
