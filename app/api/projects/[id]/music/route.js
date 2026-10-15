// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, uid, withWriteContext } from '@/lib/core/index.js';
import { startMusicJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const { asset_id, caption, lyrics, max_duration, name } = body || {};
  // 非有限数（如 "Infinity"）会一路写进工作流输入 → JSON.stringify 后变 null，ComfyUI 侧报错，这里直接挡掉
  if (max_duration != null && max_duration !== '' && (!Number.isFinite(Number(max_duration)) || Number(max_duration) < 0)) {
    return NextResponse.json({ error: 'max_duration 必须是不小于 0 的数字' }, { status: 400 });
  }

  // 资产写入包一层写上下文：否则日志来源是 'internal'、batch_id 为空，无法按批定位/回滚
  // （此处只写资产行；真正的生成在 startMusicJob 里走 runTool，另有 agent:* 来源）。
  const r = withWriteContext('POST /api/projects/:id/music', () => {
    if (asset_id) {
      // 编辑/重新生成：更新已有资产并重新置为「生成中」
      const a = Assets.get(asset_id);
      if (!a || a.project_id !== id || a.category !== 'music') return { status: 404, error: '背景音乐资产不存在' };
      Assets.update(a.id, {
        name: name || a.name,
        prompt: caption != null ? caption : a.prompt,
        lyrics: lyrics != null ? lyrics : (a.lyrics || ''),
        max_duration: max_duration != null ? Number(max_duration) : (a.max_duration || 0),
        status: 'generating',
      });
      return { asset: a };
    }
    // 新建：立即创建一条「生成中」的音乐资产，让列表即时可见
    if (!caption) return { status: 400, error: '缺少 caption（音乐描述）' };
    const a = Assets.create(id, { category: 'music', name: name || ('背景音乐-' + uid().slice(0, 6)) });
    Assets.update(a.id, { status: 'generating', prompt: caption, lyrics: lyrics || '', max_duration: max_duration != null ? Number(max_duration) : 0 });
    return { asset: a };
  });
  if (r.error) return NextResponse.json({ error: r.error }, { status: r.status });

  const job = startMusicJob({ projectId: id, assetId: r.asset.id, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
