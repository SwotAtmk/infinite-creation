// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, withWriteContext } from '@/lib/core/index.js';
import { startAssetVoiceJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  const text = body?.text != null ? String(body.text) : '';
  const voice_description = body?.voice_description != null ? String(body.voice_description) : '';
  // 没有朗读文案就没有音色样本：直接拒绝，避免生成器跑起来才报错（重试老数据时也可能缺 text）
  if (!text.trim()) return NextResponse.json({ error: '缺少朗读文案 text' }, { status: 400 });
  // 记录本次生成参数（供「重试」复用）并置为生成中
  withWriteContext('POST /api/projects/:id/assets/:aid/design-voice', () => {
    Assets.update(aid, { params: { text, voice_description }, status: 'generating' });
  });
  // 提交即入全局队列，逐个执行（不再因已有任务而拒绝）
  const job = startAssetVoiceJob({ projectId: id, assetId: aid, text, voiceDescription: voice_description, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
