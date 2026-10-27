// 消费明细：普通用户只能看自己；管理员可看全部或指定 userId。
// 同时返回任务状态和计费备注（“中断后仍计费”会显示在 note 里）。
import { NextResponse } from 'next/server';
import { Usage } from '@/lib/core/index.js';
import { authenticateRequest, authEnabled } from '@/lib/core/auth.js';
import { getAccount } from '@/lib/core/billing.js';
import { loadConfig } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const url = new URL(req.url);
  const user = authenticateRequest(req, url);
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const isAdmin = !authEnabled() || user.role === 'admin';
  const askedUser = url.searchParams.get('userId') || '';
  const ownerId = isAdmin ? askedUser : user.id;

  const projectId = url.searchParams.get('projectId') || '';
  const kind = url.searchParams.get('kind') || '';
  const interrupted = url.searchParams.get('interrupted') === '1';
  const days = Math.max(0, Number(url.searchParams.get('days')) || 0);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const f = { ownerId, projectId, kind, since, interrupted };

  const items = Usage.listDetailed({ ...f, limit, offset });
  const total = Usage.countDetailed(f);
  const accountOwner = ownerId || user.id;
  return NextResponse.json({
    isAdmin,
    ownerId: ownerId || null,
    items,
    total,
    limit,
    offset,
    account: accountOwner ? getAccount(accountOwner, loadConfig()) : null,
    stats: Usage.statsFor({ ownerId, projectId, since }),
  });
}
