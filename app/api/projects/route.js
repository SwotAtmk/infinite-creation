// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, Shots, Chapters, ensureChapterPoster, ensureProjectDirs, withWriteContext } from '@/lib/core/index.js';
import { listAdminUserIds } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize')) || 10);
  const userId = req.headers.get('x-ic-user-id') || '';
  const role = req.headers.get('x-ic-user-role') || '';
  // 访客只能看到管理员的作品（展示库）；登录用户看到自己的 + 管理员的（db 层已按角色过滤）
  const isGuest = req.headers.get('x-ic-guest') === '1';
  const adminIds = new Set(listAdminUserIds());
  const all = isGuest
    ? Projects.list().filter((p) => adminIds.has(p.owner_id) && p.is_public !== false)
    : Projects.list().filter(
        (p) =>
          !userId ||
          role === 'admin' ||
          p.owner_id === userId ||
          (adminIds.has(p.owner_id) && p.is_public !== false),
      );
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
      id: p.id, name: p.name, style: p.style, status: p.status,
      owner_id: p.owner_id || '',
      is_public: p.is_public !== false,
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
  // 项目归属由服务端决定，忽略客户端传入的 owner_id
  const owner_id = req.headers.get('x-ic-user-id') || '';
  // 整段包在写上下文里：项目 + 自动创建的「第1章」共享同一 batch_id，可整批回滚
  return withWriteContext('POST /api/projects', async () => {
    try {
      const p = Projects.create({ ...(body || {}), owner_id });
      ensureProjectDirs(p.id);
      return NextResponse.json(p);
    } catch (e) {
      // 项目级分辨率 / 宽高比枚举、自定义宽高区间（分镜会继承它出片）：底层抛错，这里翻成 400
      if (e && e.code === 'BAD_PROJECT_ENUM') return NextResponse.json({ error: e.message }, { status: 400 });
      if (e && e.code === 'BAD_PROJECT_DIM') return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
}
