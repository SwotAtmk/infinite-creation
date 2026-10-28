// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, Queue, withWriteContext } from '@/lib/core/index.js';
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
  const mode = body?.mode === 'i2i' ? 'i2i' : 't2i';
  const prompt = body?.prompt != null ? String(body.prompt) : (a.prompt || '');
  const reference_image_path = body?.reference_image_path ? String(body.reference_image_path) : '';
  // 记录本次生成参数（供「重试」复用）并置为生成中
  withWriteContext('POST /api/projects/:id/assets/:aid/generate', () => {
    Assets.update(aid, { params: { mode, prompt, reference_image_path }, status: 'generating' });
  });
  // 去重检查通过后入全局队列，逐个执行
  const job = startAssetImageJob({ projectId: id, assetId: aid, mode, prompt, referenceImagePath: reference_image_path, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
