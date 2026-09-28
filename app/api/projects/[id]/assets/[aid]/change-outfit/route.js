// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';
import { startCostumeJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  if (a.category !== 'character') return NextResponse.json({ error: '只能对角色（人物）资产换装' }, { status: 400 });
  if (!body?.outfit) return NextResponse.json({ error: '缺少 outfit（服装描述）' }, { status: 400 });
  const job = startCostumeJob({ projectId: id, characterId: aid, outfit: body.outfit, prompt: body?.prompt, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
