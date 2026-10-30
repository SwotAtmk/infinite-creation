// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 简单模式页「数字人」：先语音克隆（参考音色 + 说话内容）生成语音，再以头像 + 语音跑 r2v 数字人。
// avatar / ref_audio 为相对路径；ref_audio_project_id 用于跨项目复用已有音色（缺省当前项目）。
import { NextResponse } from 'next/server';
import { Projects, Assets, uid, withWriteContext } from '@/lib/core/index.js';
import { startDigitalHumanTtsJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { text = '', prompt = '', seconds, resolution, aspect_ratio, avatar = '', ref_audio = '', ref_audio_project_id = '', name = '', asset_id = '' } = body || {};
  if (!String(text || '').trim()) return NextResponse.json({ error: '缺少说话内容 text' }, { status: 400 });
  if (!String(prompt || '').trim()) return NextResponse.json({ error: '缺少动作描述提示词 prompt' }, { status: 400 });
  if (!String(avatar || '').trim()) return NextResponse.json({ error: '缺少人物头像 avatar' }, { status: 400 });
  if (!String(ref_audio || '').trim()) return NextResponse.json({ error: '缺少参考音色 ref_audio' }, { status: 400 });

  let asset;
  if (asset_id) {
    asset = Assets.get(asset_id);
    if (!asset || asset.project_id !== id || asset.category !== 'video') return NextResponse.json({ error: '视频资产不存在' }, { status: 404 });
  } else {
    asset = Assets.create(id, { category: 'video', name: name || ('数字人-' + uid().slice(0, 6)) });
  }

  const paramsObj = {
    mode: 'digital_human_tts',
    text: String(text),
    prompt: String(prompt),
    seconds: Number(seconds) || 5,
    resolution,
    aspect_ratio,
    avatar: String(avatar),
    ref_audio: String(ref_audio),
    ref_audio_project_id: String(ref_audio_project_id || ''),
  };
  withWriteContext('POST /api/projects/:id/digital-human', () => {
    Assets.update(asset.id, { status: 'generating', prompt: String(prompt || ''), params: paramsObj });
  });

  const job = startDigitalHumanTtsJob({
    projectId: id,
    assetId: asset.id,
    text: String(text),
    prompt: String(prompt),
    seconds,
    resolution,
    aspectRatio: aspect_ratio,
    avatar: String(avatar),
    refAudio: String(ref_audio),
    refAudioProjectId: String(ref_audio_project_id || ''),
    onProgress: (p) => broadcast(p),
  });
  return NextResponse.json(job);
}
