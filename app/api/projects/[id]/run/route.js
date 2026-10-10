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
  const job = startCreateJob({ projectId: id, chapter: body?.chapter, onProgress: (patch) => broadcast(patch) });
  return NextResponse.json(job);
}
