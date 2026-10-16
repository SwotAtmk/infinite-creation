// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Jobs, loadConfig, interruptTask } from '@/lib/core/index.js';
import { stopJob, holdsRenderSlot } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 取消单个任务：排队中的立即出队中止；执行中的打停止标记（工具/ComfyUI 收到后中断）。
// 取消不会破坏已完成结果——已 done 的分镜/资产保持原状（见 tools.js 的恢复逻辑）。
// 可取消的任务 = 走渲染闸门的任务（界面 CANCELLABLE 同一口径）；行内任务见下。
export async function POST(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  if (!job || job.projectId !== id) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (job.status !== 'running' && job.status !== 'queued') return NextResponse.json({ error: '任务已结束' }, { status: 409 });
  // 「状态是 running」≠「占着渲染槽位」：行内任务（llm 参考图分析 / export 按章导出）在请求内
  // 同步执行、不进闸门，也没有任何代码读它的停止标记——取消对它是空操作，却会走到下面的
  // /interrupt，把**当时真正在跑的渲染任务**（全局槽位串行，可能是另一个项目的整片生成）打断，
  // 让它以 failed 收场。这种任务没有取消入口（界面也不给按钮），这里如实拒绝而不是假成功。
  if (job.status === 'running' && !holdsRenderSlot(jobId)) {
    return NextResponse.json({ error: '该任务在请求内同步执行（不占渲染队列），不支持取消，请等它结束' }, { status: 409 });
  }
  stopJob(jobId);
  // 执行中的任务：主动打断 ComfyUI 当前 prompt，让取消立即生效（否则要等 generate() 轮询到下一拍）。
  // 只有「执行中」才打断——「排队中」的任务并未占用 ComfyUI，误打断会杀掉正在跑的前排任务。
  if (job.status === 'running') {
    try { const cfg = loadConfig(); await interruptTask(cfg); } catch {}
  }
  return NextResponse.json({ ok: true, id: jobId });
}
