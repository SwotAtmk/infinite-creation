// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, Queue } from '@/lib/core/index.js';
import { startAssetImageJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  // 同一素材已有排队/执行中的渲染（可能来自流水线）：直接拒绝，避免重复渲染与重复扣费
  const active = Queue.activeByDedupe('asset:' + aid);
  if (active) {
    return NextResponse.json(
      { error: '该素材已有渲染任务在排队或执行中', code: 'ALREADY_RENDERING', jobId: active.jobId, queueId: active.id },
      { status: 409 },
    );
  }
  // 提交即入全局队列，逐个执行（不再因已有任务而拒绝）
  const job = startAssetImageJob({ projectId: id, assetId: aid, mode: body?.mode === 'i2i' ? 'i2i' : 't2i', prompt: body?.prompt, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
