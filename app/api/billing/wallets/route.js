// 管理后台：查看所有账号积分、充值/调整。仅管理员可用（server.js 里 requiresAdmin）。
import { NextResponse } from 'next/server';
import { listUsers } from '@/lib/core/auth.js';
import { Wallet } from '@/lib/core/db.js';
import { topUpCredits } from '@/lib/core/billing.js';
import { loadConfig } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = loadConfig();
  const currency = cfg.billing?.currency || '点';
  const items = listUsers().map((u) => {
    const wallet = Wallet.ensure(u.id, currency) || Wallet.get(u.id);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      disabled: !!u.disabled,
      wallet,
    };
  });
  return NextResponse.json({ items, currency });
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body?.userId || '').trim();
  const amount = Number(body?.amount);
  if (!userId) return NextResponse.json({ error: '缺少 userId' }, { status: 400 });
  if (!Number.isFinite(amount) || amount === 0) return NextResponse.json({ error: 'amount 必须是非 0 数字' }, { status: 400 });
  try {
    const wallet = topUpCredits(userId, amount, { note: String(body?.note || '管理员调整') });
    return NextResponse.json({ ok: true, wallet });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
