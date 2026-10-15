// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, uid } from '@/lib/core/index.js';
import { startMusicJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const { asset_id, caption, lyrics, max_duration, name } = body || {};

  let asset;
  if (asset_id) {
    // 编辑/重新生成：更新已有资产并重新置为「生成中」
    asset = Assets.get(asset_id);
    if (!asset || asset.project_id !== id || asset.category !== 'music') return NextResponse.json({ error: '背景音乐资产不存在' }, { status: 404 });
    Assets.update(asset.id, {
      name: name || asset.name,
      prompt: caption != null ? caption : asset.prompt,
      lyrics: lyrics != null ? lyrics : (asset.lyrics || ''),
      max_duration: max_duration != null ? Number(max_duration) : (asset.max_duration || 0),
      status: 'generating',
    });
  } else {
    // 新建：立即创建一条「生成中」的音乐资产，让列表即时可见
    if (!caption) return NextResponse.json({ error: '缺少 caption（音乐描述）' }, { status: 400 });
    asset = Assets.create(id, { category: 'music', name: name || ('背景音乐-' + uid().slice(0, 6)) });
    Assets.update(asset.id, { status: 'generating', prompt: caption, lyrics: lyrics || '', max_duration: max_duration != null ? Number(max_duration) : 0 });
  }

  const job = startMusicJob({ projectId: id, assetId: asset.id, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
