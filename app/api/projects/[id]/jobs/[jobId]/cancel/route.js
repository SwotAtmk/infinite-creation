// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Jobs, loadConfig, interrupt } from '@/lib/core/index.js';
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
  // 执行中的任务：主动打断 ComfyUI 当前 prompt，让取消立即生效（否则要等 generate() 轮询到下一拍）。
  // 只有「执行中」才打断——「排队中」的任务并未占用 ComfyUI，误打断会杀掉正在跑的前排任务。
  if (job.status === 'running') {
    try { const cfg = loadConfig(); if (cfg?.comfyui?.baseUrl) await interrupt(cfg.comfyui.baseUrl); } catch {}
  }
  return NextResponse.json({ ok: true, id: jobId });
}
