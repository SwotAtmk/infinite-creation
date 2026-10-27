// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, Shots, Chapters, ensureChapterPoster, ensureProjectDirs, withWriteContext } from '@/lib/core/index.js';
import { splitNovelIntoChapters, PROJECT_TYPES } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize')) || 10);
  const type = url.searchParams.get('type') || '';
  let all = Projects.list();
  // 首页左侧菜单按类型分栏：指定 type 时只列该类型的项目（非法 type 直接忽略，避免报错打扰加载）
  if (type && PROJECT_TYPES.includes(type)) all = all.filter((p) => (p.type || 'agent') === type);
  const start = (page - 1) * pageSize;
  const items = await Promise.all(all.slice(start, start + pageSize).map(async (p) => {
    const shots = Shots.list(p.id);
    const firstChapter = Chapters.list(p.id)[0];
    let poster = '';
    if (firstChapter) {
      const firstDone = shots.find((s) => s.chapter === firstChapter.title && s.status === 'done' && s.video_path);
      poster = firstDone ? await ensureChapterPoster(p.id, firstChapter.id, firstDone) : '';
    }
    return {
      id: p.id, name: p.name, type: p.type || 'agent', style: p.style, status: p.status,
      assetCount: Assets.list(p.id).length, shotCount: shots.length,
      updatedAt: p.updated_at,
      poster,
    };
  }));
  return NextResponse.json({ items, total: all.length, page, pageSize, hasMore: start + items.length < all.length });
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  if (!body || !String(body.name || '').trim()) return NextResponse.json({ error: '缺少 name' }, { status: 400 });
  // 整段包在写上下文里：项目 + 自动创建的「第1章」共享同一 batch_id，可整批回滚
  return withWriteContext('POST /api/projects', async () => {
    try {
      // 长篇小说自动拆分：识别章节标题 / 超长按字数均分，单章结果走现状路径（向后兼容）
      const chapters = splitNovelIntoChapters(String(body.novel || ''));
      const p = Projects.create({ ...body, chapters: chapters.length > 1 ? chapters : null });
      ensureProjectDirs(p.id);
      return NextResponse.json(p);
    } catch (e) {
      // 项目级分辨率 / 宽高比枚举、自定义宽高区间（分镜会继承它出片）：底层抛错，这里翻成 400
      if (e && e.code === 'BAD_PROJECT_ENUM') return NextResponse.json({ error: e.message }, { status: 400 });
      if (e && e.code === 'BAD_PROJECT_DIM') return NextResponse.json({ error: e.message }, { status: 400 });
      if (e && e.code === 'BAD_PROJECT_TYPE') return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
}
