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
  const job = startRegenerateJob({ projectId: id, shotId: sid, feedback: body?.feedback, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
