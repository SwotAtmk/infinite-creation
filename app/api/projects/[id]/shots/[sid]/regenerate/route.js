// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots } from '@/lib/core/index.js';
import { startRegenerateJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  if (!shot) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  // 不再因「已有任务」拒绝：提交即入全局队列，等前面任务跑完自动逐个执行（ComfyUI 单队列）
  const job = startRegenerateJob({ projectId: id, shotId: sid, feedback: body?.feedback, render: body?.render, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
