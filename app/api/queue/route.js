// 渲染队列观测接口：用户看自己的排队位置，管理员看全局 + 可恢复暂停的队列。
import { NextResponse } from 'next/server';
import { authEnabled } from '@/lib/core/auth.js';
import { queueSnapshot, resumeQueue } from '@/lib/core/scheduler.js';

export const dynamic = 'force-dynamic';

function actor(req) {
  if (!authEnabled()) return { userId: 'local', isAdmin: true };
  return {
    userId: req.headers.get('x-ic-user-id') || '',
    isAdmin: (req.headers.get('x-ic-user-role') || '') === 'admin',
  };
}

export async function GET(req) {
  const { userId, isAdmin } = actor(req);
  return NextResponse.json(queueSnapshot({ ownerId: userId, isAdmin }));
}

// 管理员操作：{"action":"resume"} 手动恢复被自动暂停的队列（余额/并发超限后）
export async function POST(req) {
  const { isAdmin } = actor(req);
  if (!isAdmin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'resume') {
    resumeQueue();
    return NextResponse.json({ ok: true, ...queueSnapshot({}) });
  }
  return NextResponse.json({ error: '未知操作' }, { status: 400 });
}
