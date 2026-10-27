// 当前用户的积分账户：余额、在途预授权、今日/本月已用、按项目汇总、最近用量。
import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/core/auth.js';
import { getAccount, walletEnabled } from '@/lib/core/billing.js';
import { loadConfig } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const user = authenticateRequest(req, new URL(req.url));
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const ownerId = user.id === 'local' ? 'local' : user.id;
  const cfg = loadConfig();
  return NextResponse.json({ enabled: walletEnabled(cfg), ...getAccount(ownerId, cfg) });
}
