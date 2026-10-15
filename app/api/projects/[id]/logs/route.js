// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, listChanges, countChanges } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 变更日志（内容表的增删改留档，可回滚）。日志随项目删除而清空，不会自动清理。
export async function GET(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const url = new URL(req.url);
  const items = listChanges(id, {
    entity: url.searchParams.get('entity') || undefined,
    action: url.searchParams.get('action') || undefined,
    source: url.searchParams.get('source') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  });
  return NextResponse.json({ total: countChanges(id), items });
}
