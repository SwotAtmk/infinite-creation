// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';
import { startAssetVoiceJob, assertRenderSeparation } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  // 渲染任务提交前校验 LLM/ComfyUI 分离
  try { assertRenderSeparation(); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  // 提交即入全局队列，逐个执行（不再因已有任务而拒绝）
  const job = startAssetVoiceJob({ projectId: id, assetId: aid, text: body?.text, voiceDescription: body?.voice_description, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
