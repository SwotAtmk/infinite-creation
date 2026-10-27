// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, withWriteContext } from '@/lib/core/index.js';
import { startAssetImageJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  const mode = body?.mode === 'i2i' ? 'i2i' : 't2i';
  const prompt = body?.prompt != null ? String(body.prompt) : (a.prompt || '');
  const reference_image_path = body?.reference_image_path ? String(body.reference_image_path) : '';
  // 记录本次生成参数（供「重试」复用）并置为生成中
  withWriteContext('POST /api/projects/:id/assets/:aid/generate', () => {
    Assets.update(aid, { params: { mode, prompt, reference_image_path }, status: 'generating' });
  });
  // 提交即入全局队列，逐个执行（不再因已有任务而拒绝）
  const job = startAssetImageJob({ projectId: id, assetId: aid, mode, prompt, referenceImagePath: reference_image_path, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
