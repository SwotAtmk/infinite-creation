// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, Projects, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  const url = new URL(req.url);
  const category = url.searchParams.get('category') || null;
  return NextResponse.json(Assets.list(id, category));
}

export async function POST(req, { params }) {
  const { id } = await params;
  const { category = 'other', name, description = '' } = await req.json().catch(() => ({}));
  if (!name) return NextResponse.json({ error: '缺少 name' }, { status: 400 });
  // 同 chapters POST：先确认项目存在，避免写出挂在不存在项目下的孤儿素材行
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return withWriteContext('POST /api/projects/:id/assets', async () => NextResponse.json(Assets.create(id, { category, name, description })));
}
