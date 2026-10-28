// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, listChanges, countChanges } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';


export async function GET(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const url = new URL(req.url);
  const filters = {
    entity: url.searchParams.get('entity') || undefined,
    action: url.searchParams.get('action') || undefined,
    source: url.searchParams.get('source') || undefined,
  };
  const items = listChanges(id, {
    ...filters,
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  });
  // total 必须与 items 同口径（同一组筛选）：否则客户端按 total 翻页会翻出空页
  return NextResponse.json({ total: countChanges(id, filters), items });
}
