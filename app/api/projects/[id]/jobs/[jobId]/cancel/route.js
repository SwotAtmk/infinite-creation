// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Jobs } from '@/lib/core/index.js';
import { stopJob } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 取消单个任务：排队中的立即出队中止；执行中的打停止标记（工具/ComfyUI 收到后中断）。
// 取消不会破坏已完成结果——已 done 的分镜/资产保持原状（见 tools.js 的恢复逻辑）。
export async function POST(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  if (!job || job.projectId !== id) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (job.status !== 'running' && job.status !== 'queued') return NextResponse.json({ error: '任务已结束' }, { status: 409 });
  stopJob(jobId);
  return NextResponse.json({ ok: true, id: jobId });
}
