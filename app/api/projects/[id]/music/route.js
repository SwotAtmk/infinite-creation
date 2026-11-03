// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, uid, withWriteContext, loadConfig, logger, optimizeMusicBrief } from '@/lib/core/index.js';
import { startMusicJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const project = Projects.get(id);
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const { asset_id, caption, lyrics, max_duration, name, optimize } = body || {};
  // 非有限数（如 "Infinity"）会一路写进工作流输入 → JSON.stringify 后变 null，ComfyUI 侧报错，这里直接挡掉
  if (max_duration != null && max_duration !== '' && (!Number.isFinite(Number(max_duration)) || Number(max_duration) < 0)) {
    return NextResponse.json({ error: 'max_duration 必须是不小于 0 的数字' }, { status: 400 });
  }

  const existing = asset_id ? Assets.get(asset_id) : null;
  if (asset_id && (!existing || existing.project_id !== id || existing.category !== 'music')) {
    return NextResponse.json({ error: '背景音乐资产不存在' }, { status: 404 });
  }
  const inputChanged = caption != null || lyrics != null;
  const baseCaption = String((caption != null ? caption : existing?.prompt) || '').trim();
  const baseLyrics = String(lyrics != null ? lyrics : (existing?.lyrics || ''));
  if (!asset_id && !baseCaption) return NextResponse.json({ error: '缺少 caption（音乐描述）' }, { status: 400 });

  // 生成前先按 music-caption-rewriter 技能重写：caption → 结构化英文 caption，歌词 → 带段落标签的编曲版本。
  // 同一份原始输入只重写一次（结果缓存在 params.caption_rewrite，重试直接复用）；optimize:false 可关闭；
  // LLM 未配置或改写失败时回退原始输入，不阻断生成。
  const cfg = loadConfig();
  const cached = existing?.params?.caption_rewrite || null;
  // 只有「原样重试」（没传新的 caption/lyrics）才复用缓存；用户改了任一输入就重新改写。
  const cacheHit = !inputChanged && !!(cached && cached.caption
    && String(cached.source_caption || '') === baseCaption);
  let rewrite = cacheHit ? { caption: cached.caption, lyrics: cached.lyrics } : null;
  if (!rewrite && optimize !== false && baseCaption && cfg?.llm?.baseUrl) {
    try {
      rewrite = await optimizeMusicBrief({
        llm: cfg.llm,
        caption: baseCaption,
        lyrics: baseLyrics,
        duration: max_duration,
        style: project.style,
      });
    } catch (e) {
      logger.warn('music: music-caption-rewriter 优化失败，按原始输入生成：' + (e?.message || e), { projectId: id });
    }
  }
  const usedLyrics = String(rewrite ? rewrite.lyrics : baseLyrics);
  const rewriteParams = rewrite
    ? { source_caption: baseCaption, source_lyrics: baseLyrics, caption: rewrite.caption, lyrics: usedLyrics, at: new Date().toISOString() }
    : null;

  // 资产写入包一层写上下文：否则日志来源是 'internal'、batch_id 为空，无法按批定位/回滚
  // （此处只写资产行；真正的生成在 startMusicJob 里走 runTool，另有 agent:* 来源）。
  const r = withWriteContext('POST /api/projects/:id/music', () => {
    if (asset_id) {
      // 编辑/重新生成：更新已有资产并重新置为「生成中」
      const a = Assets.get(asset_id);
      if (!a || a.project_id !== id || a.category !== 'music') return { status: 404, error: '背景音乐资产不存在' };
      const params = { ...(a.params || {}) };
      if (rewriteParams) params.caption_rewrite = rewriteParams;
      // 输入变了但这次没改写成功：清掉上一次的缓存，避免生成时用旧的结构化 caption
      else if (inputChanged) delete params.caption_rewrite;
      Assets.update(a.id, {
        name: name || a.name,
        // prompt 始终保留用户原始输入；真正提交给模型的 caption 见 params.caption_rewrite
        prompt: caption != null ? baseCaption : a.prompt,
        lyrics: usedLyrics,
        max_duration: max_duration != null ? Number(max_duration) : (a.max_duration || 0),
        params,
        status: 'generating',
      });
      return { asset: a };
    }
    // 新建：立即创建一条「生成中」的音乐资产，让列表即时可见
    const a = Assets.create(id, { category: 'music', name: name || ('背景音乐-' + uid().slice(0, 6)) });
    Assets.update(a.id, {
      status: 'generating',
      prompt: baseCaption,
      lyrics: usedLyrics,
      max_duration: max_duration != null ? Number(max_duration) : 0,
      params: rewriteParams ? { caption_rewrite: rewriteParams } : {},
    });
    return { asset: a };
  });
  if (r.error) return NextResponse.json({ error: r.error }, { status: r.status });

  const job = startMusicJob({ projectId: id, assetId: r.asset.id, onProgress: (p) => broadcast(p) });
  // optimized 供前端提示用：技能改写成功才提示「已优化」，失败会退回原始输入但仍照常生成。
  return NextResponse.json({ ...job, optimized: !!rewrite });
}
