// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, Queue, withWriteContext } from '@/lib/core/index.js';
import { startAssetVoiceJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  const active = Queue.activeByDedupe('voice:' + aid);
  if (active) {
    return NextResponse.json(
      { error: '该角色已有音色任务在排队或执行中', code: 'ALREADY_RENDERING', jobId: active.jobId, queueId: active.id },
      { status: 409 },
    );
  }
  const voice_description = body?.voice_description != null ? String(body.voice_description) : '';
  // 朗读文案：显式传入 > 上次生成用的文案（资产页「重新生成」不提供文案）> 声音画像 > 通用自我介绍，
  // 与 design_voice 工具的兜底保持一致；都为空的资产才会拒绝。
  const text =
    (body?.text != null ? String(body.text) : '').trim() ||
    String(a.params?.text || '').trim() ||
    String(a.voice_desc || '').trim() ||
    ('你好，我是' + a.name + '。很高兴认识你。').trim();
  if (!text) return NextResponse.json({ error: '缺少朗读文案 text' }, { status: 400 });
  // 记录本次生成参数（供「重试」复用）并置为生成中
  withWriteContext('POST /api/projects/:id/assets/:aid/design-voice', () => {
    Assets.update(aid, { params: { text, voice_description }, status: 'generating' });
  });
  // 去重检查通过后入全局队列，逐个执行
  const job = startAssetVoiceJob({ projectId: id, assetId: aid, text, voiceDescription: voice_description, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
