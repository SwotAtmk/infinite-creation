// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';
import { startAssetImageJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  const job = startAssetImageJob({ projectId: id, assetId: aid, mode: body?.mode === 'i2i' ? 'i2i' : 't2i', prompt: body?.prompt, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
