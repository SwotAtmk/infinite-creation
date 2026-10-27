// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, listChanges, countChanges } from '@/lib/core/index.js';
import { authEnabled, currentAuthUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

// 变更日志里有每条内容的 before/after 全文，属于项目私有数据，不随「展示项目」公开：
// 访客与「非项目归属人的普通用户」都不允许读取（界面上的日志 Tab 在只读模式也已隐藏）。
function canReadPrivate(projectId) {
  if (!authEnabled()) return true;
  const user = currentAuthUser();
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Projects.ownerOf(projectId) === user.id;
}

export async function GET(req, { params }) {
  const { id } = await params;
  if (!canReadPrivate(id)) {
    return NextResponse.json({ error: '无权查看该项目日志' }, { status: 403 });
  }
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
