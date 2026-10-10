// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { startCreateJob, activeJobOf, assertRenderSeparation } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (activeJobOf(id)) return NextResponse.json({ error: '已有运行中的任务' }, { status: 409 });
  // 全自动流水线会同时用到 LLM 与渲染：开启 vision 时先拦下（单卡不能同时常驻）
  try { assertRenderSeparation(); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  Projects.update(id, { status: 'running' });
  const job = startCreateJob({ projectId: id, chapter: body?.chapter, onProgress: (patch) => broadcast(patch) });
  return NextResponse.json(job);
}
