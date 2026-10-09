// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';
import { startAgeJob, activeJobOf } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  if (a.category !== 'character') return NextResponse.json({ error: '只能对角色（人物）资产设定年龄' }, { status: 400 });
  if (!body?.age) return NextResponse.json({ error: '缺少 age（年龄/时期描述）' }, { status: 400 });
  if (activeJobOf(id)) return NextResponse.json({ error: '已有运行中的任务' }, { status: 409 });
  const job = startAgeJob({ projectId: id, characterId: aid, age: body.age, prompt: body?.prompt, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}