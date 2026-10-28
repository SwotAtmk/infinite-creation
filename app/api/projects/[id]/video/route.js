// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 简单模式页「视频生成 / 数字人」：直接跑 MiniMax H3 Easy 工作流的 r2v（reference/image/digital_human）。
// references 为已通过 /media 上传的物料相对路径列表：[{ type:'image'|'audio'|'video', filename }]。
// 传 asset_id 表示「重试/重新生成」已存在的视频资产，否则新建。
import { NextResponse } from 'next/server';
import { Projects, Assets, uid, withWriteContext } from '@/lib/core/index.js';
import { startVideoJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { mode = 'reference', prompt = '', seconds, resolution, aspect_ratio, references = [], name = '', asset_id = '' } = body || {};
  if (!String(prompt || '').trim()) return NextResponse.json({ error: '缺少视频提示词 prompt' }, { status: 400 });
  if (!Array.isArray(references)) return NextResponse.json({ error: 'references 必须是数组' }, { status: 400 });

  let asset;
  if (asset_id) {
    asset = Assets.get(asset_id);
    if (!asset || asset.project_id !== id || asset.category !== 'video') return NextResponse.json({ error: '视频资产不存在' }, { status: 404 });
  } else {
    asset = Assets.create(id, { category: 'video', name: name || ('视频-' + uid().slice(0, 6)) });
  }

  const paramsObj = { mode, prompt: String(prompt || ''), seconds: Number(seconds) || 5, resolution, aspect_ratio, references };
  withWriteContext('POST /api/projects/:id/video', () => {
    Assets.update(asset.id, { status: 'generating', prompt: String(prompt || ''), params: paramsObj });
  });

  const job = startVideoJob({
    projectId: id,
    assetId: asset.id,
    mode,
    prompt: String(prompt || ''),
    seconds,
    resolution,
    aspectRatio: aspect_ratio,
    references,
    onProgress: (p) => broadcast(p),
  });
  return NextResponse.json(job);
}
