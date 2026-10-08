// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { STAGES, pendingByStage, preflight, startStageJob, activeJobOf } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 勾选前的状态：各阶段待办数 + 当前 ComfyUI 实例能不能跑所选组合
export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ stages: STAGES, pending: pendingByStage(id) });
}

// 起一批阶段任务。拦截逻辑放在 preflight，失败要回 400 并带上原因——
// 前端 alert 出来，别让人白等 3 分钟才发现 LLM 没启动。
export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  const stages = Array.isArray(body?.stages) ? body.stages : [];
  const chapter = body?.chapter || '';
  try {
    const info = await preflight(stages);
    if (activeJobOf(id)) return NextResponse.json({ error: '已有运行中的任务' }, { status: 409 });
    // 前端「运行中」判定读的是 project.status（ProjectView.jsx:42），与 /run 同一套做法
    Projects.update(id, { status: 'running' });
    const job = startStageJob({ projectId: id, stages, chapter, onProgress: (patch) => broadcast(patch) });
    return NextResponse.json({ job, ...info });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}