// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, Shots, ensureProjectDirs, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const list = Projects.list().map((p) => ({
    id: p.id, name: p.name, style: p.style, status: p.status,
    assetCount: Assets.list(p.id).length, shotCount: Shots.list(p.id).length,
    updatedAt: p.updated_at,
  }));
  return NextResponse.json(list);
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  if (!body || !String(body.name || '').trim()) return NextResponse.json({ error: '缺少 name' }, { status: 400 });
  // 整段包在写上下文里：项目 + 自动创建的「第1章」共享同一 batch_id，可整批回滚
  return withWriteContext('POST /api/projects', async () => {
    try {
      const p = Projects.create(body || {});
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
