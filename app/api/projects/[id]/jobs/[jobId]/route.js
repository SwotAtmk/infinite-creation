// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, loadConfig, interrupt, projectDir } from '@/lib/core/index.js';
import { stopJob } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 删除任务记录。
// - 活动任务（执行中/排队中）：先取消（打停止标记 + 立即出队；执行中的再主动打断 ComfyUI），
//   否则排队任务仍会被执行、运行任务仍占显存。
// - 已结束任务：直接删记录。
// 只删「任务记录」与其日志，不删任务产出的素材/视频（那是资产，独立于任务记录）。
export async function DELETE(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  if (!job || job.projectId !== id) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  const running = job.status === 'running';
  const active = running || job.status === 'queued';
  if (active) stopJob(jobId);
  if (running) { try { const cfg = loadConfig(); if (cfg?.comfyui?.baseUrl) await interrupt(cfg.comfyui.baseUrl); } catch {} }
  // 清掉任务级日志文件
  try { fs.unlinkSync(path.join(projectDir(id), 'logs', jobId + '.log')); } catch {}
  if (job.logPath) { try { fs.unlinkSync(job.logPath); } catch {} }
  Jobs.remove(jobId);
  return NextResponse.json({ ok: true, cancelled: active, id: jobId });
}
