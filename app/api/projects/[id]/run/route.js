// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { startCreateJob, activeJobOf } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (activeJobOf(id)) return NextResponse.json({ error: '已有运行中的任务' }, { status: 409 });
  Projects.update(id, { status: 'running' });
  try {
    const job = startCreateJob({ projectId: id, chapter: body?.chapter, onProgress: (patch) => broadcast(patch) });
    return NextResponse.json(job);
  } catch (e) {
    // 前置约束不通过（如 AMD 单卡禁用整条流水线）：任务没起来，复位项目运行态再回 400，
    // 让前端把原因弹出来，而不是留下一个永远「运行中」的项目。
    Projects.update(id, { status: 'idle' });
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
