// 整章/整项目费用预估：不做预授权，只给用户一个“这次大概要花多少、余额够不够”的参考。
// 实际扣费仍按每一步的预授权单价为准（提示词/时长变化会影响实际金额）。
import { NextResponse } from 'next/server';
import { Chapters, Projects, Usage, loadConfig } from '@/lib/core/index.js';
import { estimateProjectCost } from '@/lib/agent/index.js';
import { getAccount } from '@/lib/core/billing.js';
import { currentAuthUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function projectSpent(ownerId, projectId) {
  if (!ownerId) return 0;
  const row = Usage.sumByProject(ownerId, 0).find((x) => x.projectId === projectId);
  return row ? row.amount : 0;
}

export async function GET(req, { params }) {
  const { id } = await params;
  const project = Projects.get(id);
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const url = new URL(req.url);
  const chapter = url.searchParams.get('chapter') || '';
  const all = url.searchParams.get('all') === '1';
  const cfg = loadConfig();
  const ownerId = Projects.ownerOf(id) || currentAuthUser()?.id || '';
  const chapters = Chapters.list(id);
  if (chapter && !chapters.some((c) => c.title === chapter || c.id === chapter)) {
    return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  }

  const account = getAccount(ownerId, cfg);
  const user = currentAuthUser();
  const canSeeWallet = !!user && (user.role === 'admin' || user.id === ownerId);
  const wallet = canSeeWallet
    ? { enabled: cfg.billing?.wallet?.enabled === true, balance: account.balance, held: account.held, available: account.available, currency: account.currency }
    : { enabled: cfg.billing?.wallet?.enabled === true, currency: account.currency };
  const spent = canSeeWallet ? projectSpent(ownerId, id) : null;
  const currency = cfg.billing?.currency || '点';

  if (all) {
    const list = chapters.map((c) => {
      const est = estimateProjectCost(id, c.title, cfg);
      return { id: c.id, title: c.title, total: est.total, currency: est.currency, items: est.items };
    });
    const whole = estimateProjectCost(id, '', cfg);
    return NextResponse.json({
      projectId: id,
      all: true,
      chapter: null,
      currency,
      chapters: list,
      whole: { total: whole.total, currency: whole.currency, items: whole.items },
      wallet,
      enough: canSeeWallet ? account.available + 1e-9 >= whole.total : null,
      spent,
    });
  }

  const est = estimateProjectCost(id, chapter, cfg);
  return NextResponse.json({
    projectId: id,
    chapter: chapter || null,
    currency,
    prices: est.items,
    total: est.total,
    wallet,
    enough: canSeeWallet ? account.available + 1e-9 >= est.total : null,
    spent,
  });
}
