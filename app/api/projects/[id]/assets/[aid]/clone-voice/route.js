// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, Queue, withWriteContext } from '@/lib/core/index.js';
import { startAssetVoiceCloneJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const body = await req.json().catch(() => ({}));
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  if (a.category !== 'voice') return NextResponse.json({ error: '该资产不是语音资产' }, { status: 400 });
  const active = Queue.activeByDedupe('voice-clone:' + aid);
  if (active) {
    return NextResponse.json(
      { error: '该音色已有克隆任务在排队或执行中', code: 'ALREADY_RENDERING', jobId: active.jobId, queueId: active.id },
      { status: 409 },
    );
  }
  const text = body?.text != null ? String(body.text) : '';
  const ref_audio = body?.ref_audio != null ? String(body.ref_audio) : '';
  const ref_audio_project_id = body?.ref_audio_project_id != null ? String(body.ref_audio_project_id) : '';
  if (!text.trim()) return NextResponse.json({ error: '缺少说话内容 text' }, { status: 400 });
  if (!ref_audio.trim()) return NextResponse.json({ error: '缺少参考音色 ref_audio' }, { status: 400 });
  withWriteContext('POST /api/projects/:id/assets/:aid/clone-voice', () => {
    Assets.update(aid, { params: { text, ref_audio, ref_audio_project_id }, status: 'generating' });
  });
  const job = startAssetVoiceCloneJob({ projectId: id, assetId: aid, text, refAudio: ref_audio, refAudioProjectId: ref_audio_project_id, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
